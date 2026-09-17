import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { ConnectorError } from './http.ts';
export type AdsColumns = { date: string; campaignId: string; impressions?: string; clicks?: string; spend?: string; conversions?: string; currency?: string };
export type AdsCsvConfig = { projectId: string; source: string; accountId: string; currency: string; timezone: string; columns: AdsColumns; delimiter?: ',' | ';' | '\t'; decimalSeparator?: '.' | ','; minorDigits?: number; existing?: ReadonlyMap<string, string> };
export type ImportedAdRow = { key: string; contentHash: string; projectId: string; source: string; accountId: string; campaignId: string; date: string; timezone: string; currency: string; impressions: number | null; clicks: number | null; spendMinor: string | null; conversions: number | null };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function count(value: string | undefined) { if (value === undefined || value.trim() === '') return null; if (!/^\d+$/.test(value.trim())) throw new Error('INVALID_COUNT'); const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('COUNT_OUT_OF_RANGE'); return n; }
function money(value: string | undefined, config: AdsCsvConfig) { if (value === undefined || value.trim() === '') return null; const normalized = config.decimalSeparator === ',' ? value.trim().replace(',', '.') : value.trim(); const digits = config.minorDigits ?? 2; if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits || 1}})?$`).test(normalized) || (digits === 0 && normalized.includes('.'))) throw new Error('INVALID_MONEY'); const [whole, fraction = ''] = normalized.split('.'); const n = BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0'); if (n > 10n ** 18n) throw new Error('MONEY_OUT_OF_RANGE'); return n.toString(); }
export function importAdsCsv(csv: string, config: AdsCsvConfig) {
  if (Buffer.byteLength(csv) > 2 * 1024 * 1024) throw new ConnectorError('CSV_TOO_LARGE');
  if (![config.projectId, config.source, config.accountId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 200) || !/^[A-Z]{3}$/.test(config.currency) || !Number.isInteger(config.minorDigits ?? 2) || (config.minorDigits ?? 2) < 0 || (config.minorDigits ?? 2) > 4) throw new ConnectorError('INVALID_IMPORT_CONFIG');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { throw new ConnectorError('INVALID_TIMEZONE'); }
  let records: Record<string, string>[];
  try { records = parse(csv, { bom: true, delimiter: config.delimiter ?? ',', skip_empty_lines: true, max_record_size: 64_000, columns: (headers: string[]) => { if (new Set(headers).size !== headers.length || headers.some(h => ['__proto__', 'constructor', 'prototype'].includes(h))) throw new Error('HEADER'); if (!config.columns.date || !config.columns.campaignId || Object.values(config.columns).some(c => c && !headers.includes(c))) throw new Error('HEADER'); return headers; } }); } catch { throw new ConnectorError('CSV_SCHEMA_OR_SYNTAX_INVALID'); }
  if (records.length > 10_000) throw new ConnectorError('CSV_TOO_MANY_ROWS');
  const rows: ImportedAdRow[] = [], duplicates: number[] = [], errors: { row: number; code: string }[] = [], conflicts: { row: number; key: string; existingHash: string; incomingHash: string }[] = [];
  const seen = new Map(config.existing);
  for (const [index, record] of records.entries()) {
    const line = index + 2;
    try {
      const cell = (field: keyof AdsColumns) => config.columns[field] ? record[config.columns[field]!] : undefined;
      const date = cell('date')?.trim() ?? ''; const campaignId = cell('campaignId')?.trim() ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('INVALID_DATE');
      if (!campaignId || campaignId.length > 200 || /[\u0000-\u001f]/.test(campaignId)) throw new Error('INVALID_CAMPAIGN');
      const currency = cell('currency')?.trim() || config.currency;
      if (currency !== config.currency) throw new Error('CURRENCY_MISMATCH');
      const data = { projectId: config.projectId, source: config.source, accountId: config.accountId, campaignId, date, timezone: config.timezone, currency, impressions: count(cell('impressions')), clicks: count(cell('clicks')), spendMinor: money(cell('spend'), config), conversions: count(cell('conversions')) };
      const key = sha([config.projectId, config.source, config.accountId, campaignId, date, config.timezone, currency]); const contentHash = sha(data);
      const existing = seen.get(key);
      if (existing === contentHash) { duplicates.push(line); continue; }
      if (existing) { conflicts.push({ row: line, key, existingHash: existing, incomingHash: contentHash }); continue; }
      seen.set(key, contentHash); rows.push({ key, contentHash, ...data });
    } catch (error) { errors.push({ row: line, code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_ROW' }); }
  }
  const numeric = (field: 'impressions' | 'clicks' | 'conversions') => { if (!rows.length || rows.some(r => r[field] === null)) return null; const total = rows.reduce((a, r) => a + r[field]!, 0); return Number.isSafeInteger(total) ? total : null; };
  const impressions = numeric('impressions'), clicks = numeric('clicks');
  return { source: config.source, currency: config.currency, timezone: config.timezone, rows, duplicates, conflicts, errors, totals: { impressions, clicks, conversions: numeric('conversions'), spendMinor: rows.length && rows.every(r => r.spendMinor !== null) ? rows.reduce((a, r) => a + BigInt(r.spendMinor!), 0n).toString() : null, clickThroughRate: impressions !== null && impressions > 0 && clicks !== null ? clicks / impressions : null }, importedRows: rows.length, provenance: 'csv_import' as const };
}
