import { parseLibraryFilters, type LibraryFilters } from './library-query.ts';
import { shortSummary } from './library-upgrade.ts';

export type ExportFormat = 'csv' | 'xlsx';
export type ExportScope = 'all' | 'collection' | 'filtered';
export type ExportSelection = { format: ExportFormat; scope: ExportScope; filters: LibraryFilters };
export type ExportCollection = { id: string; name: string };
export type ExportRecord = {
  id: string;
  title: string;
  creator: string;
  platform: string;
  tags: string[];
  createdAt: string;
  url: string;
  status: string;
  transcript: string;
  collectionId: string | null;
  collectionName: string;
  notes?: string; summary?: string; reviewedAt?: string;
};

export const EXPORT_HEADERS = ['Collection', 'Title', 'Creator', 'Platform', 'Tags', 'Saved at (UTC)', 'Source URL', 'Transcript', 'Status', 'Item ID', 'Notes', 'Summary', 'Reviewed at (UTC)'] as const;
export const EXPORT_LIMITS = {
  csv: { records: 5_000, textBytes: 8 * 1024 * 1024 },
  xlsx: { records: 2_500, textBytes: 2 * 1024 * 1024 },
} as const;
export const EXCEL_CELL_LIMIT = 32_767;
const EXCEL_LINE_FEED_LIMIT = 253;

export class ExportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
  }
}

export function parseExportSelection(params: URLSearchParams): ExportSelection {
  const format = params.get('format') ?? 'csv';
  const scope = params.get('scope') ?? 'all';
  if (format !== 'csv' && format !== 'xlsx') throw new ExportError(400, 'Choose Excel or CSV for your export.');
  if (scope !== 'all' && scope !== 'collection' && scope !== 'filtered') throw new ExportError(400, 'Choose the whole library, a collection, or filtered results.');
  const selected = scope === 'filtered' ? new URLSearchParams(params) : new URLSearchParams();
  if (scope === 'collection') {
    const collectionId = params.get('collectionId');
    if (!collectionId || collectionId.length > 100) throw new ExportError(400, 'Choose a collection to export.');
    selected.set('collectionId', collectionId);
  }
  if (params.has('ids')) selected.set('ids', params.get('ids')!);
  selected.delete('page');
  selected.delete('pageSize');
  return { format, scope, filters: parseLibraryFilters(selected) };
}

export function exportLimitMessage(format: ExportFormat) {
  const limit = EXPORT_LIMITS[format];
  const alternative = format === 'xlsx' ? ' Choose CSV, export a collection, or narrow your filters.' : ' Export a collection or narrow your filters.';
  return `This export is too large (${limit.records.toLocaleString('en-US')} items or ${limit.textBytes / 1024 / 1024} MB of text per ${format === 'xlsx' ? 'Excel' : 'CSV'} download). No items were exported.${alternative}`;
}

export function checkExportSize(format: ExportFormat, count: number, textBytes: number) {
  const limit = EXPORT_LIMITS[format];
  if (count > limit.records || textBytes > limit.textBytes) throw new ExportError(413, exportLimitMessage(format));
}

export function toExportRecord(row: Record<string, unknown>): ExportRecord {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.tags ?? '[]'));
    if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === 'string');
  } catch { /* Legacy malformed tags have no usable values. */ }
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const collectionId = text(row.collection_id) || null;
  let summary = '';
  try { const insights = JSON.parse(String(row.insights ?? 'null')); summary = typeof insights?.summary === 'string' ? shortSummary(insights.summary) : ''; } catch { /* No generated summary. */ }
  return {
    id: text(row.id), title: text(row.edited_title ?? row.generated_title ?? row.title), creator: text(row.creator),
    platform: text(row.platform) || 'tiktok', tags, createdAt: text(row.created_at),
    url: text(row.url), status: text(row.status), transcript: text(row.transcript),
    notes: text(row.notes), summary, reviewedAt: text(row.reviewed_at),
    collectionId, collectionName: collectionId ? text(row.collection_name) : 'Unsorted',
  };
}

const collectionLabel = (record: ExportRecord) => record.collectionId ? record.collectionName : 'Unsorted';

export function sortExportRecords(records: readonly ExportRecord[]) {
  return [...records].sort((left, right) => collectionLabel(left).localeCompare(collectionLabel(right), 'en', { sensitivity: 'base' }) ||
    (left.collectionId ?? '').localeCompare(right.collectionId ?? '') ||
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export function exportRecordCells(record: ExportRecord, transcript = record.transcript): string[] {
  return [collectionLabel(record), record.title, record.creator, record.platform, record.tags.join(', '), record.createdAt, record.url, transcript, record.status, record.id, record.notes ?? '', record.summary ?? '', record.reviewedAt ?? ''];
}

// Quoting alone does not stop a spreadsheet from evaluating imported CSV cells.
export function csvCell(value: string) {
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function exportCsv(records: readonly ExportRecord[]) {
  const lines = [EXPORT_HEADERS.map(csvCell).join(',')];
  for (const record of sortExportRecords(records)) lines.push(exportRecordCells(record).map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function trimUtf16(value: string, maximum: number) {
  let end = Math.min(value.length, maximum);
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
  return value.slice(0, end);
}

export function safeSheetName(name: string, used: Set<string>) {
  const cleaned = name.replace(/[\\/*?:\[\]\u0000-\u001f\u007f\uD800-\uDFFF\uFFFE\uFFFF]/gu, ' ')
    .replace(/_x([0-9a-f]{4})_/giu, 'x$1').trim().replace(/^'+|'+$/gu, '').trim() || 'Collection';
  const base = trimUtf16(cleaned, 31).replace(/'+$/gu, '') || 'Collection';
  let candidate = base;
  let suffix = 2;
  while (candidate.toLocaleLowerCase('en-US') === 'history' || used.has(candidate.toLocaleLowerCase('en-US'))) {
    const ending = ` (${suffix++})`;
    candidate = trimUtf16(base, 31 - ending.length) + ending;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

/** Preserve XML-invalid characters using SpreadsheetML ST_Xstring escapes. */
export function excelText(value: string) {
  const literalEscapes = value.replace(/_x[0-9a-f]{4}_/giu, match => '_x005F_' + match.slice(1));
  let encoded = '';
  for (let index = 0; index < literalEscapes.length; index++) {
    const code = literalEscapes.charCodeAt(index);
    const pairedHigh = code >= 0xD800 && code <= 0xDBFF && index + 1 < literalEscapes.length && literalEscapes.charCodeAt(index + 1) >= 0xDC00 && literalEscapes.charCodeAt(index + 1) <= 0xDFFF;
    if (pairedHigh) { encoded += literalEscapes[index] + literalEscapes[++index]; continue; }
    if ((code <= 0x1F && code !== 0x09 && code !== 0x0A) || code === 0x7F || code === 0xFFFE || code === 0xFFFF || (code >= 0xD800 && code <= 0xDFFF)) {
      encoded += `_x${code.toString(16).padStart(4, '0').toUpperCase()}_`;
    } else encoded += literalEscapes[index];
  }
  return encoded;
}

/** Parts concatenate to the exact original transcript, including line endings. */
export function splitTranscript(value: string): string[] {
  if (!value) return [''];
  const parts: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = start + trimUtf16(value.slice(start, start + EXCEL_CELL_LIMIT + 1), EXCEL_CELL_LIMIT).length;
    let lineFeeds = 0;
    for (let index = start; index < end; index++) {
      if (value[index] === '\n' && ++lineFeeds > EXCEL_LINE_FEED_LIMIT) { end = index; break; }
    }
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

function httpsLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(value) ? url.href : null;
  } catch { return null; }
}

export async function exportXlsx(records: readonly ExportRecord[], collections: readonly ExportCollection[] = []): Promise<Uint8Array> {
  // The browser build contains its own ZIP implementation and has no fs/stream dependency.
  const { default: ExcelJS } = await import('exceljs/dist/exceljs.min.js');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cliptext';
  workbook.subject = 'Private transcript library export';
  const sorted = sortExportRecords(records);
  const used = new Set(['all items', 'unsorted', 'transcript parts', 'text parts', 'history']);
  const collectionMap = new Map(collections.map(collection => [collection.id, collection.name]));
  for (const record of sorted) if (record.collectionId && !collectionMap.has(record.collectionId)) collectionMap.set(record.collectionId, record.collectionName);
  const partRows: (string | number)[][] = [];
  const partStart = new Map<string, { row: number; count: number }>();
  for (const record of sorted) {
    const parts = splitTranscript(record.transcript);
    if (parts.length <= 1) continue;
    partStart.set(record.id, { row: partRows.length + 2, count: parts.length });
    parts.forEach((part, index) => partRows.push([record.id, collectionLabel(record), record.title, index + 1, parts.length, part]));
  }

  const extraRows: (string | number)[][] = [];
  const extraParts = new Map<string, { row: number; count: number }>();
  for (const record of sorted) {
    for (const field of ['notes', 'summary'] as const) {
      const parts = splitTranscript(record[field] ?? '');
      if (parts.length <= 1) continue;
      extraParts.set(`${record.id}:${field}`, { row: extraRows.length + 2, count: parts.length });
      parts.forEach((part, index) => extraRows.push([record.id, field, index + 1, parts.length, part]));
    }
  }

  function createSheet(name: string, headers: readonly string[], widths: number[]) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = headers.map((header, index) => ({ header, width: widths[index] ?? 20 }));
    sheet.getRow(1).font = { name: 'Calibri', bold: true, color: { argb: 'FFEEF8FF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3850' } };
    sheet.getRow(1).height = 24;
    return sheet;
  }

  function videoSheet(name: string, rows: readonly ExportRecord[]) {
    const sheet = createSheet(name, EXPORT_HEADERS, [26, 42, 24, 14, 26, 25, 44, 80, 16, 39, 60, 60, 25]);
    for (const record of rows) {
      const parts = partStart.get(record.id);
      const transcript = parts ? `Full transcript: ${parts.count} parts in Transcript parts (Item ID: ${record.id})` : record.transcript;
      const cells = exportRecordCells(record, transcript);
      for (const [index, field] of ['notes', 'summary'].entries()) {
        const extra = extraParts.get(`${record.id}:${field}`);
        if (extra) cells[index + 10] = `Full ${field}: ${extra.count} parts in Text parts (Item ID: ${record.id})`;
      }
      const row = sheet.addRow(cells.map(excelText));
      for (const [index, field] of ['notes', 'summary'].entries()) {
        const extra = extraParts.get(`${record.id}:${field}`);
        if (extra) { row.getCell(index + 11).value = { text: excelText(cells[index + 10]), hyperlink: `#'Text parts'!A${extra.row}` }; row.getCell(index + 11).font = { color: { argb: 'FF2A6898' }, underline: true }; }
      }
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = 45;
      const url = httpsLink(record.url);
      if (url) {
        row.getCell(7).value = { text: excelText(record.url), hyperlink: url };
        row.getCell(7).font = { color: { argb: 'FF2A6898' }, underline: true };
      }
      if (parts) {
        row.getCell(8).value = { text: excelText(transcript), hyperlink: `#'Transcript parts'!A${parts.row}` };
        row.getCell(8).font = { color: { argb: 'FF2A6898' }, underline: true };
      }
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: EXPORT_HEADERS.length } };
  }

  videoSheet('All items', sorted);
  for (const [id, name] of [...collectionMap].sort((a, b) => a[1].localeCompare(b[1], 'en', { sensitivity: 'base' }) || a[0].localeCompare(b[0]))) {
    videoSheet(safeSheetName(name, used), sorted.filter(record => record.collectionId === id));
  }
  videoSheet('Unsorted', sorted.filter(record => !record.collectionId));
  if (partRows.length) {
    const sheet = createSheet('Transcript parts', ['Item ID', 'Collection', 'Title', 'Part', 'Total parts', 'Transcript text'], [39, 26, 42, 10, 12, 100]);
    for (const values of partRows) {
      const row = sheet.addRow(values.map(value => typeof value === 'string' ? excelText(value) : value));
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = 45;
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: 6 } };
  }
  if (extraRows.length) {
    const sheet = createSheet('Text parts', ['Item ID', 'Field', 'Part', 'Total parts', 'Text'], [39, 20, 10, 12, 100]);
    for (const values of extraRows) { const row = sheet.addRow(values.map(value => typeof value === 'string' ? excelText(value) : value)); row.alignment = { vertical: 'top', wrapText: true }; row.height = 45; }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: 5 } };
  }
  const buffer = await workbook.xlsx.writeBuffer({ useSharedStrings: true });
  return new Uint8Array(buffer);
}
