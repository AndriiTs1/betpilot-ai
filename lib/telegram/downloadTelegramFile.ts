// Stage 14.1 — the official Telegram Bot API two-step file download: getFile
// (resolves file_id -> a short-lived file_path) then a plain GET against the
// file endpoint. Same AbortController+timeout convention already used
// client-side in components/miniapp/betScreenshotApi.ts and server-side in
// lib/ai/betParser.ts's Claude calls. Uses the global `fetch` directly (no
// injected fetch parameter) — same convention as lib/telegram/sendMessage.ts,
// which is what lets tests stub `global.fetch` exactly the way
// app/api/bets/settle.route.test.ts already does for that module.
//
// The bot token appears only inside the request URLs built and used in this
// file — never passed to console.log/console.error, and every error variant
// below carries structured fields (status codes, byte counts) instead of
// raw response bodies or URLs, so a caller logging the *error* can never
// accidentally leak the token either.

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10000;

export interface DownloadTelegramFileParams {
  fileId: string;
  botToken: string;
  // Enforced twice: once against getFile's own reported file_size (before
  // any download traffic happens at all) and once against the actual
  // downloaded byte count (Telegram's metadata is informative, not a
  // guarantee).
  maxBytes: number;
  timeoutMs?: number;
}

export interface TelegramFileDownload {
  buffer: Buffer;
  sizeBytes: number;
  filePath: string;
}

export type DownloadTelegramFileError =
  | { kind: "GET_FILE_FAILED"; status?: number }
  | { kind: "MISSING_FILE_PATH" }
  | { kind: "DOWNLOAD_FAILED"; status?: number }
  | { kind: "FILE_TOO_LARGE"; sizeBytes: number }
  | { kind: "TIMEOUT" }
  | { kind: "NETWORK_ERROR" };

export type DownloadTelegramFileResult =
  | { ok: true; download: TelegramFileDownload }
  | { ok: false; error: DownloadTelegramFileError };

interface TelegramGetFileResponseBody {
  ok?: boolean;
  result?: { file_path?: string; file_size?: number };
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadTelegramFile(
  params: DownloadTelegramFileParams,
): Promise<DownloadTelegramFileResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  let getFileResponse: Response;
  try {
    getFileResponse = await fetchWithTimeout(
      `https://api.telegram.org/bot${params.botToken}/getFile?file_id=${encodeURIComponent(params.fileId)}`,
      timeoutMs,
    );
  } catch (err) {
    return { ok: false, error: isAbortError(err) ? { kind: "TIMEOUT" } : { kind: "NETWORK_ERROR" } };
  }

  if (!getFileResponse.ok) {
    return { ok: false, error: { kind: "GET_FILE_FAILED", status: getFileResponse.status } };
  }

  const getFileBody: TelegramGetFileResponseBody | null = await getFileResponse.json().catch(() => null);
  const filePath = getFileBody?.result?.file_path;

  if (!getFileBody?.ok || !filePath) {
    return { ok: false, error: { kind: "MISSING_FILE_PATH" } };
  }

  // Reject before spending any download bandwidth when Telegram's own
  // metadata already says it's too large (Part 8's "reject oversized files
  // before download when Telegram metadata contains file_size").
  const reportedSize = getFileBody.result?.file_size;
  if (typeof reportedSize === "number" && reportedSize > params.maxBytes) {
    return { ok: false, error: { kind: "FILE_TOO_LARGE", sizeBytes: reportedSize } };
  }

  let downloadResponse: Response;
  try {
    downloadResponse = await fetchWithTimeout(
      `https://api.telegram.org/file/bot${params.botToken}/${filePath}`,
      timeoutMs,
    );
  } catch (err) {
    return { ok: false, error: isAbortError(err) ? { kind: "TIMEOUT" } : { kind: "NETWORK_ERROR" } };
  }

  if (!downloadResponse.ok) {
    return { ok: false, error: { kind: "DOWNLOAD_FAILED", status: downloadResponse.status } };
  }

  const buffer = Buffer.from(await downloadResponse.arrayBuffer());

  // The real, authoritative check — Telegram's getFile metadata is
  // informative only, not a guarantee of the actual body size.
  if (buffer.byteLength > params.maxBytes) {
    return { ok: false, error: { kind: "FILE_TOO_LARGE", sizeBytes: buffer.byteLength } };
  }

  return { ok: true, download: { buffer, sizeBytes: buffer.byteLength, filePath } };
}
