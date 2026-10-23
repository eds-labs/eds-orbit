// CSV writing for finance exports: RFC 4180 quoting, CRLF line ends, and a
// guard against spreadsheet formula injection.

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
// Plain decimals are system-produced amounts (credit notes and reversals are
// negative); they stay numeric for the tax advisor.
const DECIMAL = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: formula-looking text gets a leading `'`, then RFC 4180 quoting. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (FORMULA_START.test(text) && !DECIMAL.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, terminated by CRLF. */
export const csvRow = (values: (string | number | null)[]): string =>
  `${values.map(csvCell).join(",")}\r\n`;

/** A whole file: UTF-8 BOM (so spreadsheets read UTF-8) plus the rows. */
export function csvFile(rows: string[]): Uint8Array {
  const body = new TextEncoder().encode(rows.join(""));
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
}
