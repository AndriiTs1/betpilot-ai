"use client";

import { useState } from "react";

// Stage 14.4A, Part F — client-side counterpart to
// app/api/dashboard/debug/screenshot-preview/route.ts. Deliberately plain:
// this is a diagnostic tool, not a polished product surface. Renders
// exactly what the debug API returns — nothing is fetched or computed
// client-side beyond the one upload request.

interface DebugSelection {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  submittedOdds: number | null;
  currentOdds?: number | null;
  oddsStatus?: string;
}

interface DebugResponse {
  error?: string;
  totalDurationMs?: number;
  ocr?:
    | { kind: "SUCCESS"; durationMs: number; mimeType: string; sizeBytes: number; normalizedText: string }
    | { kind: "FAILURE"; durationMs: number; code: string; safeMessage: string };
  parser?:
    | { mode: string; durationMs: number; valid: true; type: string; stake: number; selectionCount: number; selections: DebugSelection[] }
    | { mode: string; durationMs: number; valid: false; code?: string; error: string };
  oddsVerification?: { durationMs: number; selections?: DebugSelection[]; failed?: boolean; code?: string };
  preview?: { type: string; stake: number; totalOdds: number | null; potentialWin: number | null };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800/70 bg-[#0b1220] p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-300">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-200">{value}</span>
    </div>
  );
}

export default function ScreenshotDebugForm() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugResponse | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.set("image", file, file.name);

      const response = await fetch("/api/dashboard/debug/screenshot-preview", {
        method: "POST",
        body: formData,
      });

      const body = (await response.json()) as DebugResponse;

      if (!response.ok) {
        setError(body.error ?? `Request failed (${response.status})`);
        return;
      }

      setResult(body);
    } catch {
      setError("Network error — request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex items-center gap-3">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-slate-300"
        />
        <button
          type="submit"
          disabled={!file || loading}
          className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Running pipeline..." : "Run diagnostic"}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      {result?.totalDurationMs !== undefined && (
        <Section title="Total">
          <Field label="Total duration" value={`${result.totalDurationMs} ms`} />
        </Section>
      )}

      {result?.ocr && (
        <Section title="OCR">
          <Field label="Result" value={result.ocr.kind} />
          <Field label="Duration" value={`${result.ocr.durationMs} ms`} />
          {result.ocr.kind === "SUCCESS" ? (
            <>
              <Field label="MIME type" value={result.ocr.mimeType} />
              <Field label="Size" value={`${result.ocr.sizeBytes} bytes`} />
              <div className="mt-2">
                <span className="text-xs text-slate-500">Normalized OCR text</span>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-slate-300">
                  {result.ocr.normalizedText}
                </pre>
              </div>
            </>
          ) : (
            <>
              <Field label="Failure code" value={result.ocr.code} />
              <Field label="Message" value={result.ocr.safeMessage} />
            </>
          )}
        </Section>
      )}

      {result?.parser && (
        <Section title="Parser">
          <Field label="Mode" value={result.parser.mode} />
          <Field label="Duration" value={`${result.parser.durationMs} ms`} />
          <Field label="Valid" value={String(result.parser.valid)} />
          {result.parser.valid ? (
            <>
              <Field label="Type" value={result.parser.type} />
              <Field label="Stake" value={result.parser.stake} />
              <Field label="Selection count" value={result.parser.selectionCount} />
              <div className="mt-2 flex flex-col gap-2">
                {result.parser.selections.map((selection, index) => (
                  <div key={index} className="rounded-lg border border-slate-800 p-2 text-xs text-slate-300">
                    <div>{selection.sport} — {selection.event}</div>
                    <div className="text-slate-400">{selection.selection}</div>
                    <div className="text-slate-500">odds: {selection.submittedOdds ?? "—"}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {result.parser.code && <Field label="Failure code" value={result.parser.code} />}
              <Field label="Error" value={result.parser.error} />
            </>
          )}
        </Section>
      )}

      {result?.oddsVerification && (
        <Section title="Odds verification">
          <Field label="Duration" value={`${result.oddsVerification.durationMs} ms`} />
          {result.oddsVerification.failed ? (
            <Field label="Failed" value={result.oddsVerification.code ?? "unknown"} />
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {result.oddsVerification.selections?.map((selection, index) => (
                <div key={index} className="rounded-lg border border-slate-800 p-2 text-xs text-slate-300">
                  <div>{selection.event} — {selection.selection}</div>
                  <div className="text-slate-500">
                    status: {selection.oddsStatus} · current odds: {selection.currentOdds ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {result?.preview && (
        <Section title="Preview">
          <Field label="Type" value={result.preview.type} />
          <Field label="Stake" value={result.preview.stake} />
          <Field label="Total odds" value={result.preview.totalOdds ?? "—"} />
          <Field label="Potential win" value={result.preview.potentialWin ?? "—"} />
        </Section>
      )}
    </div>
  );
}
