// Stage 14.2 — deterministic, provider-independent OCR text cleanup. This
// is intentionally the *only* thing this file does: whitespace/byte-level
// hygiene, nothing that touches meaning. It must never guess missing words,
// translate, classify sport, identify events, parse stake/odds, or call an
// LLM — that is explicitly bet-parsing's job (a later, separate stage), not
// this one's. Odds notations like "2.05", "1,85", "+1.5", "-0.5" are never
// matched or rewritten by anything below — no regex here targets digits,
// decimal separators, or +/- signs at all.

const NULL_BYTE_PATTERN = new RegExp(String.fromCharCode(0x0000), "g");
const NBSP_PATTERN = new RegExp(String.fromCharCode(0x00a0), "g");

export function normalizeOcrText(rawText: string): string {
  return rawText
    // CRLF/CR -> LF
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Null bytes can't be stored/displayed meaningfully anywhere downstream.
    .replace(NULL_BYTE_PATTERN, "")
    // Non-breaking space -> regular space (a bare whitespace-only change,
    // not a translation or reformatting of content).
    .replace(NBSP_PATTERN, " ")
    // Collapse 3+ consecutive newlines down to exactly one blank line —
    // preserves meaningful paragraph/line breaks, removes only excess.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
