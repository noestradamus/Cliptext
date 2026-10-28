"use client";

import { useRef, useState } from 'react';
import { requestJSON } from './library-controls';

export default function LibraryBackup({ onRestored }: { onRestored: () => void }) {
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  async function download() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/backup', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        const detail = response.headers.get('content-type')?.includes('application/json') ? await response.json() as { error?: string } : null;
        throw new Error(detail?.error || 'The backup couldn’t be prepared. Reload and try again.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `cliptext-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('Backup download started.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Backup failed. Try again.'); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!file || busy) return;
    if (file.size > 32 * 1024 * 1024) { setError('Choose a Cliptext backup smaller than 32 MB.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const text = await file.text();
      try { JSON.parse(text); } catch { throw new Error('This file isn’t a readable Cliptext JSON backup.'); }
      const result = await requestJSON<{ restored: number; skipped: number }>('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      setMessage(`${result.restored} items restored. ${result.skipped} existing items kept.`); setFile(null); if (fileRef.current) fileRef.current.value = ''; onRestored();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The backup couldn’t be restored. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className="library-backup" aria-label="Library backups" aria-busy={busy}>
    <h3>Backups</h3><p className="backup-hint">Text, notes, collections, tags, and saved images.</p>
    <button type="button" className="button-secondary" disabled={busy} onClick={() => void download()}>{busy && !file ? 'Preparing…' : 'Download backup'}</button>
    <label htmlFor="backup-file">Restore a backup</label><input ref={fileRef} id="backup-file" type="file" accept=".json,application/json" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); setMessage(''); }} />
    {file && <><p className="backup-hint">Existing items stay unchanged.</p><button type="button" className="button-primary" disabled={busy} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore backup'}</button></>}
    {error && <p className="field-error" role="alert">{error}</p>}<p className="export-message" role="status">{message}</p>
  </section>;
}
