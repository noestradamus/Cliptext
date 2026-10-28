import { libraryWhere } from './library-query.ts';
import { EXPORT_LIMITS, type ExportSelection } from './export.ts';

type ExportStatement = { sql: string; values: unknown[] };

/** The aggregate and guarded rows statements must execute in one D1 batch. */
export function buildExportQueries(selection: ExportSelection, ownerId: string): {
  count: ExportStatement; rows: ExportStatement; collections: ExportStatement;
} {
  const where = libraryWhere(selection.filters, ownerId);
  const source = `FROM jobs j LEFT JOIN collections c ON c.id=j.collection_id AND c.owner_id=j.owner_id WHERE ${where.sql}`;
  // Include per-record overhead as well as every exported source text field. Blob
  // length counts UTF-8 bytes, so multilingual transcripts cannot evade the guard.
  const textColumns = ['j.id', 'j.url', 'j.platform', 'j.status', 'COALESCE(j.edited_title,j.generated_title,j.title)', 'j.creator', 'COALESCE(j.edited_transcript,j.transcript)', 'j.created_at', 'j.tags', 'j.notes', 'j.insights', 'j.reviewed_at', 'c.name'];
  const size = '256+' + textColumns.map(column => `length(CAST(COALESCE(${column},'') AS BLOB))`).join('+');
  const totals = `SELECT COUNT(*) AS total,COALESCE(SUM(${size}),0) AS textBytes ${source}`;
  const limit = EXPORT_LIMITS[selection.format];
  return {
    count: { sql: totals, values: [...where.values] },
    rows: {
      // The WHERE guard prevents an oversized result from being materialized at
      // all. No LIMIT or UI page offset can silently exclude matching videos.
      sql: `WITH export_size AS (${totals}) SELECT j.id,j.url,j.platform,j.status,COALESCE(j.edited_title,j.generated_title,j.title) AS title,j.creator,COALESCE(j.edited_transcript,j.transcript) AS transcript,j.notes,j.insights,j.reviewed_at,j.created_at,j.tags,c.id AS collection_id,c.name AS collection_name ${source} AND (SELECT total<=? AND textBytes<=? FROM export_size) ORDER BY COALESCE(c.name,'Unsorted') COLLATE NOCASE,c.id,j.created_at DESC,j.id DESC`,
      values: [...where.values, ...where.values, limit.records, limit.textBytes],
    },
    collections: { sql: 'SELECT id,name FROM collections WHERE owner_id=? ORDER BY name COLLATE NOCASE,id', values: [ownerId] },
  };
}
