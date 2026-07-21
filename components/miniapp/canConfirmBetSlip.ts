import type { BetPreviewSuccess } from "./betPreviewApi";

// Stage 12, Phase 4, Step 5 — extracted out of BetTextForm.tsx and
// BetScreenshotForm.tsx, which had this exact condition duplicated
// byte-for-byte (both dropped the same `preview.preview.type === "SINGLE"`
// clause this step, since EXPRESS confirm is now implemented end-to-end).
// previewToken !== null is the one real technical guard: it's null exactly
// when there's nothing valid to submit yet (odds still unknown for some
// EXPRESS selection, or the preview hasn't resolved), regardless of
// SINGLE/EXPRESS. `isReady` is passed in rather than a raw phase string so
// this one function works for both forms' slightly different FormPhase
// unions without this file needing to know either of them.
export function canConfirmBetSlip(isReady: boolean, preview: BetPreviewSuccess | null): boolean {
  return isReady && preview !== null && preview.previewToken !== null;
}
