import { NextRequest, NextResponse } from "next/server";
import { requireOperatorApi } from "@/lib/auth/requireOperator";
import type { OperatorSessionStore } from "@/lib/auth/operatorSession";
import { parseBetSlipMessage, type ParseBetSlipResult } from "@/lib/ai/betParser";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import { buildBetSlipPreview, BetSlipValidationError, type BuildBetSlipPreviewOptions } from "@/lib/bets/buildBetSlipPreview";
import { recognizeScreenshot } from "@/lib/ocr/recognizeScreenshot";
import { createClaudeOcrProvider } from "@/lib/ocr/claudeOcrProvider";
import type { OcrProvider } from "@/lib/ocr/ocrTypes";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, detectImageSignature, type AllowedMimeType } from "@/lib/uploads/imageValidation";

// Stage 14.4A, Part E — operator-only diagnostic endpoint. Runs a real
// upload through the *exact same* production modules
// (recognizeScreenshot/createClaudeOcrProvider/parseBetSlipMessage/
// buildBetSlipPreview) the Mini App screenshot route uses — nothing here
// is a reimplementation, only a different (fuller) view of the same
// pipeline's intermediate results. This is a diagnostic tool, not a
// second product surface: no player lookup, no Bet/wallet write anywhere
// (this route never even imports Prisma's Bet/Transaction models), no
// previewToken in the response (a real signed, technically-redeemable
// artifact has no diagnostic value and is deliberately never handed out
// here), and it never triggers the confirm flow.
//
// ⚠️ Every field returned here — including normalizedText and the full
// parsed selections — is intended for an authenticated operator's own
// diagnostic use only. This is a materially different trust context from
// Part D's "never log" rule: that rule is about passive, automatic
// production logging (Vercel runtime logs an operator didn't ask for and
// the uploader has no visibility into); this is an explicit, on-demand
// tool where an operator uploads their own test image and the result is
// returned directly to them in the HTTP response, never persisted,
// logged, or shown to anyone else.

export const runtime = "nodejs";

export interface HandleScreenshotDebugOptions {
  previewTokenSecret?: string;
  ocrProvider?: OcrProvider;
  parseBetSlip?: typeof parseBetSlipMessage;
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  // requireOperatorApi already accepts an injectable session store — no
  // existing /api/dashboard/* route bothers to expose it (they all trust
  // requireOperatorApi's own unit tests for the auth mechanism itself),
  // but this route's pipeline is complex enough to be worth testing
  // end-to-end past a real authenticated session, so it's threaded
  // through here. Defaults to the real, DB-backed store in production.
  operatorSessionStore?: OperatorSessionStore;
}

// Never a real player — this route has no player context at all (no
// initData, no Telegram auth, no db.player lookup). buildBetSlipPreview()
// requires a playerId only to embed in the previewToken it signs, which
// this route strips from every response before returning it.
const DEBUG_PLACEHOLDER_PLAYER_ID = "debug-screenshot-preview-no-real-player";

type OcrDiagnostic =
  | { kind: "SUCCESS"; durationMs: number; mimeType: AllowedMimeType; sizeBytes: number; normalizedText: string }
  | { kind: "FAILURE"; durationMs: number; code: string; safeMessage: string };

type ParserDiagnostic =
  | { mode: "OCR"; durationMs: number; valid: true; type: "SINGLE" | "EXPRESS"; stake: number; selectionCount: number; selections: ParsedBetSlip["selections"] }
  | { mode: "OCR"; durationMs: number; valid: false; code?: "timeout"; error: string };

// Injectable so tests never make a real Claude/Odds API call — same DI
// shape as handleScreenshotPreview.
export async function handleScreenshotDebug(
  request: NextRequest,
  options: HandleScreenshotDebugOptions = {},
): Promise<NextResponse> {
  const auth = await requireOperatorApi(request, options.operatorSessionStore);
  if (!auth.ok) return auth.response;

  const totalStartedAt = Date.now();

  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("POST /api/dashboard/debug/screenshot-preview: BET_PREVIEW_TOKEN_SECRET is not set");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    const image = formData.get("image");

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
    }

    if (image.size === 0) {
      return NextResponse.json({ error: "EMPTY_FILE" }, { status: 400 });
    }

    if (image.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
    }

    if (!ALLOWED_MIME_TYPES.has(image.type as AllowedMimeType)) {
      return NextResponse.json({ error: "UNSUPPORTED_FILE_TYPE" }, { status: 415 });
    }

    const mimeType = image.type as AllowedMimeType;

    // Same in-memory-only discipline as the production route — this
    // buffer is never written to disk, a database, or any storage bucket,
    // here or anywhere downstream.
    const bytes = new Uint8Array(await image.arrayBuffer());

    const detectedType = detectImageSignature(bytes);
    if (detectedType === null || detectedType !== mimeType) {
      return NextResponse.json({ error: "INVALID_IMAGE_SIGNATURE" }, { status: 415 });
    }

    const ocrProvider = options.ocrProvider ?? createClaudeOcrProvider();

    const ocrResult = await recognizeScreenshot({
      intake: { mimeType, originalFilename: image.name || undefined },
      buffer: Buffer.from(bytes),
      provider: ocrProvider,
    });

    if (ocrResult.kind === "FAILURE") {
      const ocr: OcrDiagnostic = {
        kind: "FAILURE",
        durationMs: ocrResult.durationMs,
        code: ocrResult.code,
        safeMessage: ocrResult.safeMessage,
      };
      return NextResponse.json({ ocr, totalDurationMs: Date.now() - totalStartedAt });
    }

    const ocr: OcrDiagnostic = {
      kind: "SUCCESS",
      durationMs: ocrResult.durationMs,
      mimeType,
      sizeBytes: bytes.byteLength,
      normalizedText: ocrResult.normalizedText,
    };

    const parseBetSlip = options.parseBetSlip ?? parseBetSlipMessage;

    const parserStartedAt = Date.now();
    let parsed: ParseBetSlipResult;
    try {
      parsed = await parseBetSlip(ocrResult.normalizedText, "OCR");
    } catch (err) {
      console.error("POST /api/dashboard/debug/screenshot-preview: bet parser threw:", err);
      const parser: ParserDiagnostic = {
        mode: "OCR",
        durationMs: Date.now() - parserStartedAt,
        valid: false,
        error: "parser threw an unexpected error",
      };
      return NextResponse.json({ ocr, parser, totalDurationMs: Date.now() - totalStartedAt });
    }
    const parserDurationMs = Date.now() - parserStartedAt;

    if (!parsed.valid) {
      const parser: ParserDiagnostic = {
        mode: "OCR",
        durationMs: parserDurationMs,
        valid: false,
        code: parsed.code,
        error: parsed.error,
      };
      return NextResponse.json({ ocr, parser, totalDurationMs: Date.now() - totalStartedAt });
    }

    const slip: ParsedBetSlip = { type: parsed.type, stake: parsed.stake, selections: parsed.selections };

    const parser: ParserDiagnostic = {
      mode: "OCR",
      durationMs: parserDurationMs,
      valid: true,
      type: slip.type,
      stake: slip.stake,
      selectionCount: slip.selections.length,
      selections: slip.selections,
    };

    const oddsStartedAt = Date.now();
    let result;
    try {
      result = await buildBetSlipPreview(slip, DEBUG_PLACEHOLDER_PLAYER_ID, previewTokenSecret, {
        verifyOddsFn: options.verifyOddsFn,
      });
    } catch (err) {
      const oddsDurationMs = Date.now() - oddsStartedAt;
      if (err instanceof BetSlipValidationError) {
        return NextResponse.json({
          ocr,
          parser,
          oddsVerification: { durationMs: oddsDurationMs, failed: true, code: err.code },
          totalDurationMs: Date.now() - totalStartedAt,
        });
      }
      throw err;
    }
    const oddsDurationMs = Date.now() - oddsStartedAt;

    // previewToken is intentionally never included — it's a real signed
    // artifact with zero diagnostic value; `preview` (the human-readable
    // structured result) is what this tool exists to show.
    return NextResponse.json({
      ocr,
      parser,
      oddsVerification: { durationMs: oddsDurationMs, selections: result.preview.selections },
      preview: result.preview,
      totalDurationMs: Date.now() - totalStartedAt,
    });
  } catch (err) {
    console.error("POST /api/dashboard/debug/screenshot-preview failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleScreenshotDebug(request);
}
