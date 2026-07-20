import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { parseImageWithClaude } from "@/lib/ai/betParser";
import { verifyOdds } from "@/lib/odds/oddsVerifier";
import { signPreviewToken } from "@/lib/betPreview/previewToken";

// Stage 4.5B built server-side upload validation only. Stage 4.5C adds the
// real pipeline: magic-byte check -> base64 -> Claude multimodal -> the same
// odds verification + signed previewToken the text preview route already
// uses. Still no DB write beyond the existing read-only Player lookup, and
// no Bet/BetSelection is created here (that's confirm's job, unchanged).

// Requires node:crypto (verifyInitData/previewToken signing), Buffer
// (base64 conversion), and the Anthropic SDK — none of these run on the
// Edge runtime.
export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";
const ALLOWED_MIME_TYPES: ReadonlySet<AllowedMimeType> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Real byte-signature check, run after the MIME allow-list check below —
// a client can freely lie about a multipart part's declared Content-Type,
// this can't be. Only checks the handful of leading bytes each format
// requires; no image-processing package, no attempt to decode the image.
function detectImageSignature(bytes: Uint8Array): AllowedMimeType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Same header-parsing shape as the text preview/confirm routes and
// GET /api/miniapp/me. Duplicated rather than shared for the same reason as
// there — it's a 6-line Authorization-header parse, not the actual
// signature verification (that part *is* reused as-is via verifyInitData()).
function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

export async function POST(request: NextRequest) {
  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("POST /api/miniapp/bets/screenshot/preview: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  const previewTokenSecret = process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/miniapp/bets/screenshot/preview: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("POST /api/miniapp/bets/screenshot/preview: ANTHROPIC_API_KEY is not set");
    return NextResponse.json({ error: "AI_NOT_CONFIGURED" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);
  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    const player = await prisma.player.findUnique({
      where: { telegramId: String(verification.user.id) },
      select: { id: true },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    const image = formData.get("image");

    // Only File.size/File.type (multipart part metadata) are read here —
    // deliberately never .arrayBuffer()/.stream()/.text() on this field in
    // this sub-stage, so the file body itself is never pulled into a JS
    // buffer. Stage 4.5C is the first place that actually needs the bytes
    // (to base64-encode for Claude).
    if (!(image instanceof File)) {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    if (image.size === 0) {
      return NextResponse.json({ error: "EMPTY_FILE" }, { status: 400 });
    }

    if (image.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
    }

    // Allow-list, not a deny-list — SVG, PDF, HEIC, or anything else with an
    // unexpected MIME type is rejected by omission, not by name. The
    // filename/extension is never inspected; only the multipart part's own
    // declared Content-Type (File.type) is checked. This is still a
    // client-declared value, not byte-level sniffing — Stage 4.5C or a
    // later hardening pass may add magic-byte verification once the file is
    // actually being read into memory for the Claude call.
    if (!ALLOWED_MIME_TYPES.has(image.type as AllowedMimeType)) {
      return NextResponse.json({ error: "UNSUPPORTED_FILE_TYPE" }, { status: 415 });
    }

    const mimeType = image.type as AllowedMimeType;

    // Single read of the file body — everything downstream (signature
    // check, base64 conversion) reuses this same buffer. Nothing is ever
    // written to disk or a storage bucket; it only exists in memory for the
    // rest of this request.
    const bytes = new Uint8Array(await image.arrayBuffer());

    const detectedType = detectImageSignature(bytes);
    if (detectedType === null || detectedType !== mimeType) {
      return NextResponse.json({ error: "INVALID_IMAGE_SIGNATURE" }, { status: 415 });
    }

    const imageBase64 = Buffer.from(bytes).toString("base64");

    const parsed = await parseImageWithClaude({ imageBase64, mediaType: mimeType });

    if (!parsed.valid) {
      // parsed.detail can contain SDK/model error detail — server-side log
      // only, never in the response. Never logs the image bytes/base64.
      console.error("POST /api/miniapp/bets/screenshot/preview: parse failed:", parsed.reason, parsed.detail);

      if (parsed.reason === "timeout") {
        return NextResponse.json({ error: "AI_TIMEOUT" }, { status: 504 });
      }
      if (parsed.reason === "api_error") {
        return NextResponse.json({ error: "AI_UNAVAILABLE" }, { status: 502 });
      }
      if (parsed.reason === "incomplete") {
        return NextResponse.json({ error: "INCOMPLETE_BET_DATA" }, { status: 422 });
      }
      // "not_a_bet" | "no_tool_call"
      return NextResponse.json({ error: "IMAGE_NOT_RECOGNIZED" }, { status: 422 });
    }

    if (parsed.type === "PARLAY") {
      // Safe, explicit failure — no previewToken is signed for a shape the
      // confirm endpoint (and PreviewTokenPayload) can't represent yet
      // (type is a literal "SINGLE" there). `parsed` here only echoes back
      // data Claude read off the player's own screenshot — nothing
      // server-internal — so it's safe to return for a future UI to render.
      return NextResponse.json(
        {
          error: "PARLAY_CONFIRM_NOT_SUPPORTED",
          parsed: { type: "PARLAY", stake: parsed.stake, selections: parsed.selections },
        },
        { status: 422 },
      );
    }

    const bet = parsed.bet;

    const oddsCheck =
      bet.odds !== null
        ? await verifyOdds({ sport: bet.sport, event: bet.event, selection: bet.selection, odds: bet.odds })
        : null;

    const previewToken = signPreviewToken(
      {
        playerId: player.id,
        sport: bet.sport,
        event: bet.event,
        outcome: bet.selection,
        stake: bet.stake,
        odds: bet.odds,
        totalOdds: bet.odds,
        oddsCheck: oddsCheck
          ? {
              matched: oddsCheck.matched,
              withinTolerance: oddsCheck.withinTolerance,
              sourceOdds: oddsCheck.sourceOdds,
              bookmaker: oddsCheck.bookmaker,
            }
          : null,
      },
      previewTokenSecret,
    );

    return NextResponse.json({
      preview: {
        type: "SINGLE" as const,
        sport: bet.sport,
        event: bet.event,
        outcome: bet.selection,
        stake: bet.stake,
        odds: bet.odds,
        totalOdds: bet.odds,
        potentialWin: bet.odds !== null ? roundTo2(bet.stake * bet.odds) : null,
      },
      oddsCheck,
      previewToken,
    });
  } catch (err) {
    console.error("POST /api/miniapp/bets/screenshot/preview failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
