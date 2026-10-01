/**
 * Minimal RFC 4180 CSV with spreadsheet formula-injection protection (OWASP "CSV Injection").
 *
 * A text cell whose first non-space character is `=`, `+`, `-` or `@`, or that starts with a tab
 * or carriage return, is prefixed with `'` so Excel / LibreOffice / Sheets treat it as text rather
 * than evaluating it. Section names are free text entered by schools, so this matters even for
 * aggregate exports. Numbers are written as-is (report metrics are never negative).
 */
const FORMULA_TRIGGER = /^(?:\s*[=+\-@]|[\t\r])/;

export type CsvValue = string | number | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || text !== text.trim()) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * UTF-8 with a byte-order mark so spreadsheet software shows Kannada section names correctly;
 * CRLF line endings per RFC 4180.
 */
export function toCsv(header: readonly string[], rows: readonly CsvValue[][]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
