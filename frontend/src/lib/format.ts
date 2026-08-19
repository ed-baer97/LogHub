export function orderCode(id: number) {
  return `#CLH-${String(id).padStart(5, "0")}`;
}

export function fmtNum(n: number, digits = 0) {
  return n.toLocaleString("ru-KZ", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function deltaLabel(value?: number | null) {
  if (value == null || Number.isNaN(value)) return null;
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmtNum(value, 1)}% к прошлому периоду`;
}
