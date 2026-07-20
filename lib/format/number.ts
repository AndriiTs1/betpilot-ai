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
