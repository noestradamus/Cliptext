"use client";

import { useEffect, useRef, useState } from 'react';
import type { LibraryData, LibraryFilters } from './library-controls';

type Scope = 'all' | 'collection' | 'filtered' | 'selected';
type Format = 'xlsx' | 'csv';

export default function LibraryExport({ filters, collections, selectedIds = [], onClose }: {
  filters: LibraryFilters;
  collections: LibraryData['collections'];
  selectedIds?: string[];
  onClose: () => void;
}) {
  const hasFilters = !!(filters.q.trim() || filters.platform || filters.favorite || filters.tag);
  const [scope, setScope] = useState<Scope>(selectedIds.length ? 'selected' : hasFilters ? 'filtered' : filters.collectionId ? 'collection' : 'all');
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const scopeRef = useRef<HTMLSelectElement>(null);
  const collectionName = filters.collectionId === 'none' ? 'Unsorted' : collections.find((item) => item.id === filters.collectionId)?.name;
  const activeScope = scope === 'selected' && !selectedIds.length ? 'all' : scope === 'collection' && !collectionName ? 'all' : scope;

  useEffect(() => {
    scopeRef.current?.focus({ preventScroll: true });
    return () => requestRef.current?.abort();
  }, []);
  useEffect(() => { setError(''); setMessage(''); }, [activeScope, filters.q, filters.platform, filters.favorite, filters.tag, filters.collectionId]);

  async function download(format: Format) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(format); setError(''); setMessage('');
    const params = new URLSearchParams({ format, scope: activeScope });
    if (activeScope === 'selected') { params.set('ids', selectedIds.join(',')); params.set('scope', 'filtered'); params.set('view', filters.view); }
    if (activeScope === 'filtered') params.set('view', filters.view);
    if (activeScope !== 'all' && activeScope !== 'selected' && filters.collectionId) params.set('collectionId', filters.collectionId);
    if (activeScope === 'filtered') {
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.platform) params.set('platform', filters.platform);
      if (filters.favorite) params.set('favorite', '1');
      if (filters.tag) params.set('tag', filters.tag);
    }
    try {
      const response = await fetch(`/api/export?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        const body = type.includes('application/json') ? await response.json() as { error?: string } : null;
        throw new Error(body?.error || 'The export couldn’t be prepared. Try again.');
      }
      const expectedType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (!type.includes(expectedType)) throw new Error('Cliptext couldn’t connect. Reload and try again.');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const filename = response.headers.get('content-disposition')?.match(/filename="(cliptext-[a-z0-9.-]+)"/i)?.[1] || `cliptext-${activeScope}.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage(`${format === 'xlsx' ? 'Excel' : 'CSV'} download started.`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The export couldn’t be prepared. Try again.');
    } finally {
      if (!controller.signal.aborted) { requestRef.current = null; setBusy(null); }
    }
  }

  return <section id="library-export" className="library-export" aria-label="Export library" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <label htmlFor="export-scope">Export scope</label>
    <select ref={scopeRef} id="export-scope" value={activeScope} disabled={!!busy} onChange={(event) => setScope(event.target.value as Scope)}>
      <option value="selected" disabled={!selectedIds.length}>Selected items ({selectedIds.length})</option>
      <option value="all">Whole library</option>
      <option value="collection" disabled={!collectionName}>Current collection{collectionName ? ` · ${collectionName}` : ''}</option>
      <option value="filtered">Filtered results</option>
    </select>
    <p className="export-hint">{activeScope === 'selected' ? `${selectedIds.length} selected items.` : activeScope === 'filtered' ? 'All matches, across every page.' : activeScope === 'collection' ? 'All items in this collection.' : 'All items and collections.'}</p>
    <div className="export-actions">
      <button type="button" className="button-primary" onClick={() => void download('xlsx')} disabled={!!busy} aria-label="Download Excel">{busy === 'xlsx' ? <span className="spinner" aria-hidden="true" /> : null}Excel <span>.xlsx</span></button>
      <button type="button" className="button-secondary" onClick={() => void download('csv')} disabled={!!busy} aria-label="Download CSV">{busy === 'csv' ? <span className="spinner" aria-hidden="true" /> : null}CSV</button>
    </div>
    <p className="export-message" role="status" aria-live="polite">{busy ? 'Preparing your export…' : message}</p>
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
