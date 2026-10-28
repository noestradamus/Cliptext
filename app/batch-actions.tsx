"use client";

import { useState } from 'react';
import { requestJSON } from './library-controls';
import type { LibraryData } from './library-controls';

export default function BatchActions({ ids, collections, trash, onBusy, onExport, onDone }: {
  ids: string[]; collections: LibraryData['collections']; trash: boolean;
  onBusy: (busy: boolean) => void; onExport: () => void; onDone: (failedIds: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [tags, setTags] = useState('');
  const [action, setAction] = useState<'move' | 'tag' | ''>('');
  async function run(action: string, extra: Record<string, unknown> = {}) {
    if (busy || !ids.length) return;
    setBusy(true); onBusy(true); setError('');
    try {
      const result = await requestJSON<{ updated: number; results?: { id: string; ok: boolean; error?: string }[] }>('/api/jobs/batch', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action, ...extra }) });
      const failed = result.results?.filter(item => !item.ok) ?? [];
      if (failed.length) setError(`${result.updated} updated. ${failed.length} couldn’t be updated. ${failed[0].error ?? 'Try the remaining items again.'}`);
      else if (result.updated < ids.length) setError(`${result.updated} of ${ids.length} items updated. Refresh and try the remaining items again.`);
      setAction(''); setTags(''); onDone(failed.length ? failed.map(item => item.id) : result.updated < ids.length ? ids : []);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The selected items couldn’t be updated. Try again.'); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className="batch-actions" aria-label="Selected item actions" aria-busy={busy}>
    <p role="status">{ids.length} selected</p>
    <div className="batch-buttons">
      {trash ? <button className="button-secondary" disabled={!ids.length || busy} onClick={() => void run('restore')}>Restore</button> : <>
        <button className="button-secondary" disabled={!ids.length || busy} onClick={() => setAction(action === 'move' ? '' : 'move')}>Move</button>
        <button className="button-secondary" disabled={!ids.length || busy} onClick={() => setAction(action === 'tag' ? '' : 'tag')}>Tag</button>
        <button className="text-button" disabled={!ids.length || busy} onClick={() => void run('review', { reviewed: true })}>Mark reviewed</button>
        <button className="text-button" disabled={!ids.length || busy} onClick={() => void run('trash')}>Move to Trash</button>
      </>}
      <button className="text-button" disabled={!ids.length || busy} onClick={onExport}>Export selected</button>
    </div>
    {action === 'move' && <form className="batch-form" onSubmit={event => { event.preventDefault(); void run('move', { collectionId: collectionId || null }); }}><label htmlFor="batch-collection">Move to collection</label><select id="batch-collection" value={collectionId} disabled={busy} onChange={event => setCollectionId(event.target.value)}><option value="">Unsorted</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><button className="text-button" disabled={busy || !ids.length}>Move selected</button></form>}
    {action === 'tag' && <form className="batch-form" onSubmit={event => { event.preventDefault(); void run('tag', { tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) }); }}><label htmlFor="batch-tags">Add tags</label><input id="batch-tags" value={tags} maxLength={400} placeholder="Tags, separated by commas" disabled={busy} onChange={event => setTags(event.target.value)} /><button className="text-button" disabled={busy || !ids.length || !tags.trim()}>Add to selected</button></form>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
