import { api, ApiError, db, owner } from '../../../lib/server';
import { checkExportSize, ExportError, exportCsv, exportXlsx, parseExportSelection, toExportRecord, type ExportCollection } from '../../../lib/export';
import { buildExportQueries } from '../../../lib/export-query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return api(async () => {
    try {
      const ownerId = await owner();
      const selection = parseExportSelection(new URL(request.url).searchParams);
      const queries = buildExportQueries(selection, ownerId);
      // D1 batches are transactional. The size check and guarded projection see
      // the same library; oversized exports never load transcript data into JS.
      const [countResult, rowResult, collectionResult] = await db().batch<Record<string, unknown>>([
        db().prepare(queries.count.sql).bind(...queries.count.values),
        db().prepare(queries.rows.sql).bind(...queries.rows.values),
        db().prepare(queries.collections.sql).bind(...queries.collections.values),
      ]);
      const totals = countResult.results[0] as { total: number; textBytes: number };
      checkExportSize(selection.format, totals.total, totals.textBytes);
      const records = rowResult.results.map(toExportRecord);
      if (records.length !== totals.total) throw new ApiError(409, 'The library changed while preparing your export. Please try again.');
      let collections = collectionResult.results.map(row => ({ id: String(row.id), name: String(row.name) })) as ExportCollection[];
      if (selection.scope === 'collection') {
        const id = selection.filters.collectionId;
        if (id !== 'none' && !collections.some(collection => collection.id === id)) throw new ApiError(404, 'Collection not found.');
        collections = collections.filter(collection => collection.id === id);
      } else if (selection.scope === 'filtered') {
        const included = new Set(records.map(record => record.collectionId));
        collections = collections.filter(collection => included.has(collection.id));
      }
      const data = selection.format === 'csv' ? exportCsv(records) : await exportXlsx(records, collections);
      const filename = `cliptext-${selection.scope}-${new Date().toISOString().slice(0, 10)}.${selection.format}`;
      return new Response(data as BodyInit, {
        headers: {
          'Content-Type': selection.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'private, no-store',
          'Vary': 'Cookie',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      if (error instanceof ExportError) throw new ApiError(error.status, error.message);
      throw error;
    }
  });
}
