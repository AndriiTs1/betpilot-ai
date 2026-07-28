// Presentation-only: inserts thousand-space separators for a numeric
// display string (e.g. "10000" -> "10 000"). Never touches the underlying
// data — callers still send/store the original, unformatted string; this is
// only applied at the point a value is rendered.
export function formatDisplayNumber(value: string): string {
  const sign = value.startsWith("-") ? "-" : value.startsWith("+") ? "+" : "";
  const unsigned = sign ? value.slice(1) : value;
  const [intPart, decPart] = unsigned.split(".");

  if (!intPart || !/^\d+$/.test(intPart)) return value;

  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  return decPart !== undefined ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

// Same thousand-space grouping as formatDisplayNumber, but for a
// profit/loss-style figure that must always carry an explicit sign: "+" for
// positive, "-" for negative (formatDisplayNumber already preserves a
// leading "-"), and a bare "0" for zero — never "+0" or "-0". Used for
// Period P/L, where the sign itself is meaningful and must not rely on
// color alone (a colorblind operator, or a plain-text export, still needs
// to be able to tell profit from loss).
export function formatSignedDisplayNumber(value: string): string {
  const numeric = Number(value);

  if (numeric === 0) return "0";
  if (!Number.isFinite(numeric)) return value;

  if (value.startsWith("-")) return formatDisplayNumber(value);

  return `+${formatDisplayNumber(value)}`;
}
