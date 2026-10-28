"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import LibraryExport from './library-export';
import LibraryBackup from './library-backup';
import ThemePanel from './theme-panel';
import BatchActions from './batch-actions';
import { isImagePost } from '../lib/transcript';
import type { ImagePage } from '../lib/transcript';

export type VideoPlatform = 'tiktok' | 'youtube' | 'instagram';
export type JobStatus = 'queued' | 'downloading' | 'transcribing' | 'completed' | 'failed';
export type JobSummary = {
  id: string; url: string; title: string | null; creator: string | null;
  status: JobStatus; progress: number; language: string | null; durationSeconds: number | null;
  reviewedAt?: string | null; trashedAt?: string | null; insightStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  error: string | null; createdAt: string; updatedAt: string; platform: VideoPlatform;
  favorite: boolean; tags: string[]; collectionId: string | null; preview: string;
  frameStatus?: 'pending' | 'processing' | 'ready' | 'unavailable'; frameUrl?: string | null;
  frameWidth?: number | null; frameHeight?: number | null; frameKind?: 'thumbnail' | 'first_frame' | null;
  contentKind?: 'video' | 'image' | 'carousel'; pageCount?: number;
};
export type FullJob = JobSummary & {
  transcript: string | null; segments: { start: number; end: number; text: string }[] | null;
  pages?: ImagePage[] | null; ocrEngine?: string | null;
  originalTranscript?: string | null; originalPages?: ImagePage[] | null; originalTitle?: string | null;
  notes?: string; revision?: number;
  insights?: { summary: string; takeaways: string[]; resources: { label: string; url?: string }[] } | null;
  suggestions?: { collectionId: string | null; tags: string[] } | null;
  insightError?: string | null; insightModel?: string | null;
};
export type JobsPage = { jobs: JobSummary[]; page: number; pageSize: number; total: number; totalPages: number };
export type LibraryData = { tags: { name: string; count: number }[]; collections: { id: string; name: string; count: number }[]; stats: { total: number; completed: number; favorites: number; inbox?: number; reviewed?: number; trash?: number } };
export type LibraryFilters = { view: 'all' | 'inbox' | 'reviewed' | 'trash'; q: string; platform: '' | VideoPlatform; favorite: boolean; tag: string; collectionId: string; page: number };
export type JobChanges = { favorite?: boolean; tags?: string[]; collectionId?: string | null; title?: string; transcript?: string | null; pages?: { index: number; text: string }[] | null; notes?: string; reviewed?: boolean; restore?: boolean; acceptSuggestions?: boolean; regenerateInsights?: boolean; expectedRevision?: number };
export type CollectionChange = { type: 'created' | 'renamed' | 'deleted'; id: string };

export const DEFAULT_FILTERS: LibraryFilters = { view: 'all', q: '', platform: '', favorite: false, tag: '', collectionId: '', page: 1 };
export const statusLabels: Record<JobStatus, string> = { queued: 'Queued', downloading: 'Retrieving post', transcribing: 'Transcribing', completed: 'Ready', failed: 'Needs attention' };
export function jobStatusLabel(job: JobSummary) { return job.status === 'transcribing' && isImagePost(job) ? 'Reading images' : statusLabels[job.status]; }
export function jobExtent(job: JobSummary) { return job.contentKind === 'carousel' ? (job.pageCount ? `${job.pageCount} slides` : 'Carousel') : job.contentKind === 'image' ? 'Image' : job.durationSeconds ? timecode(job.durationSeconds) : ''; }

export function platformName(platform?: VideoPlatform | null) { return platform === 'tiktok' ? 'TikTok' : platform === 'youtube' ? 'YouTube' : platform === 'instagram' ? 'Instagram' : 'Video'; }
export function timecode(seconds: number) { const value = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }
export function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? `Today, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function jobLabel(job: JobSummary) { return job.title || `${platformName(job.platform)} ${isImagePost(job) ? 'post' : 'video'}`; }
export function isBusy(status?: JobStatus) { return status === 'queued' || status === 'downloading' || status === 'transcribing'; }
export function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }

export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'RequestError'; }
}

export async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Cliptext couldn’t connect. Reload and try again.');
  const body: unknown = await response.json();
  if (!response.ok) throw new RequestError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'That request didn’t go through. Please try again.', response.status);
  return body as T;
}

export function CliptextIcon({ name, size = 20 }: { name: string; size?: number }) {
  const shapes: Record<string, ReactNode> = {
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    link: <path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1) scale(.96)" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    share: <path d="M12 16V3m-5 5 5-5 5 5M5 12H4v8h16v-8h-1" />,
    guidebook: <><path d="M12 7v14M3 4c4-1 7 0 9 3 2-3 5-4 9-3v14c-4-1-7 0-9 3-2-3-5-4-9-3z" /><path d="M6 8c1.2 0 2.2.4 3 1M15 9c.8-.6 1.8-1 3-1M6 12c1.2 0 2.2.4 3 1M15 13c.8-.6 1.8-1 3-1" /></>,
    external: <path d="M14 3h7v7M21 3l-10 10M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    star: <path d="m12 3 2.75 5.57 6.15.89-4.45 4.34 1.05 6.13L12 17.03l-5.5 2.9 1.05-6.13L3.1 9.46l6.15-.89z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
    more: <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></>,
    inbox: <><path d="M5 4h14l3 11v5H2v-5zM2 15h6l2 3h4l2-3h6" /></>,
    restore: <><path d="M3 10a9 9 0 1 1 1 8M3 4v6h6" /></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.6-3.2l-.3-.4a1.5 1.5 0 0 1 1.2-2.4H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" /><circle cx="7.5" cy="10" r=".7" /><circle cx="10" cy="6.8" r=".7" /><circle cx="14" cy="6.8" r=".7" /><circle cx="17" cy="10" r=".7" /></>,
    filter: <path d="M4 6h16M7 12h10M10 18h4" />,
    chevronDown: <path d="m8 10 4 4 4-4" />,
    chevronLeft: <path d="m15 6-6 6 6 6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name] ?? shapes.document}</svg>;
}

function Highlight({ value, query }: { value: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return <>{value}</>;
  const expression = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const matches = new Set(terms.map((term) => term.toLocaleLowerCase()));
  return <>{value.split(expression).map((piece, index) => matches.has(piece.toLocaleLowerCase()) ? <mark key={index}>{piece}</mark> : piece)}</>;
}

function Collections({ collections, selected, onSelect, onChanged }: { collections: LibraryData['collections']; selected: string; onSelect: (id: string) => void; onChanged: (change: CollectionChange) => Promise<void> }) {
  const [editor, setEditor] = useState<{ mode: 'create' | 'rename' | 'delete'; id?: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

  function start(mode: 'create' | 'rename' | 'delete', id = '', value = '') { setMenu(null); setEditor({ mode, id, name: value }); setName(value); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || busy) return;
    if (editor.mode !== 'delete' && !name.trim()) { setError('Give the collection a name.'); return; }
    setBusy(true); setError('');
    try {
      if (editor.mode === 'create') {
        const result = await requestJSON<{ collection: { id: string; name: string } }>('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        await onChanged({ type: 'created', id: result.collection.id });
      } else if (editor.mode === 'rename') {
        await requestJSON(`/api/collections/${encodeURIComponent(editor.id!)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        await onChanged({ type: 'renamed', id: editor.id! });
      } else {
        await requestJSON(`/api/collections/${encodeURIComponent(editor.id!)}`, { method: 'DELETE' });
        await onChanged({ type: 'deleted', id: editor.id! });
      }
      setEditor(null); setName('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The collection couldn’t be saved. Try again.'); }
    finally { setBusy(false); }
  }

  return <section className="library-collections" aria-labelledby="collections-heading">
    <div className="library-section-heading"><h3 id="collections-heading">Collections</h3><button type="button" className="icon-button" aria-label="Create collection" onClick={() => start('create')} disabled={busy}><CliptextIcon name="plus" size={17} /></button></div>
    {collections.length ? <div className="collection-list">{collections.map((collection) => <div className="collection-row" key={collection.id}>
      <button type="button" className={`collection-filter ${selected === collection.id ? 'is-active' : ''}`} aria-pressed={selected === collection.id} onClick={() => { onSelect(selected === collection.id ? '' : collection.id); setMenu(null); }}><CliptextIcon name="folder" size={15} /><span>{collection.name}</span><small>{collection.count}</small></button>
      <div className="collection-menu-wrap"><button type="button" className="icon-button collection-more" aria-label={`Manage collection ${collection.name}`} aria-expanded={menu === collection.id} onClick={() => setMenu((current) => current === collection.id ? null : collection.id)} disabled={busy}><CliptextIcon name="more" size={17} /></button>{menu === collection.id && <div className="collection-menu"><button type="button" onClick={() => start('rename', collection.id, collection.name)}>Rename</button><button type="button" onClick={() => start('delete', collection.id, collection.name)}>Remove collection</button></div>}</div>
    </div>)}</div> : null}
    {editor && <form className="collection-editor" onSubmit={save}>
      {editor.mode === 'delete' ? <p>Remove <strong>{editor.name}</strong>? Items stay in your library.</p> : <><label htmlFor="collection-name">{editor.mode === 'create' ? 'New collection' : 'Rename collection'}</label><input id="collection-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} autoFocus disabled={busy} placeholder="Collection name" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setEditor(null); }} /></>}
      <div className="inline-form-actions"><button type="submit" className={editor.mode === 'delete' ? 'text-button danger-button' : 'text-button'} disabled={busy}>{busy ? 'Saving…' : editor.mode === 'delete' ? 'Remove collection' : 'Save collection'}</button><button type="button" className="text-button muted-button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>}
  </section>;
}

const desktopLibraryQuery = '(min-width: 761px)';
function subscribeDesktopLibrary(onChange: () => void) {
  const media = window.matchMedia(desktopLibraryQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
const desktopLibrarySnapshot = () => window.matchMedia(desktopLibraryQuery).matches;
const serverLibrarySnapshot = () => false;

function LibraryThumbnail({ job }: { job: JobSummary }) {
  const [failedSource, setFailedSource] = useState('');
  const source = job.frameStatus === 'ready' ? job.frameUrl : null;
  return <span className="history-thumbnail" aria-hidden="true">
    {source && failedSource !== source ? <>
      {/* Stored private preview; mobile never mounts this image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={source} alt="" width={48} height={64} loading="lazy" decoding="async" onError={() => setFailedSource(source)} />
    </> : <CliptextIcon name="document" size={19} />}
  </span>;
}

type LibraryPanel = 'theme' | 'search' | 'collections' | 'filters' | 'views' | 'tools' | 'export' | 'backup' | 'batch';

export function LibrarySidebar({ listing, library, loading, error, filters, search, selectedId, onSearch, onFilter, onReset, onSelect, onReload, onCollectionChanged }: {
  listing: JobsPage | null; library: LibraryData | null; loading: boolean; error: string; filters: LibraryFilters; search: string; selectedId: string | null;
  onSearch: (value: string) => void; onFilter: (changes: Partial<LibraryFilters>) => void; onReset: () => void; onSelect: (id: string) => void; onReload: () => void; onCollectionChanged: (change: CollectionChange) => Promise<void>;
}) {
  const showThumbnails = useSyncExternalStore(subscribeDesktopLibrary, desktopLibrarySnapshot, serverLibrarySnapshot);
  const resultsRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [panel, setPanel] = useState<LibraryPanel | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [keyboardPanel, setKeyboardPanel] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const pendingPage = useRef<{ page: number; filterKey: string } | null>(null);
  const filterKey = JSON.stringify([filters.q, filters.platform, filters.favorite, filters.tag, filters.collectionId, filters.view]);
  const panelTitle: Record<LibraryPanel, string> = { theme: 'Theme', search: 'Search', collections: 'Collections', filters: 'Filters', views: 'View', tools: 'Tools', export: 'Export', backup: 'Backups', batch: 'Selected items' };

  function placePanel(trigger = triggerRef.current) {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    const width = Math.min(mobile ? 360 : 320, window.innerWidth - 28);
    const height = panelRef.current?.offsetHeight ?? 320;
    const left = Math.max(14, Math.min(mobile ? (window.innerWidth - width) / 2 : rect.right + 14, window.innerWidth - width - 14));
    const top = mobile ? Math.max(14, Math.min(rect.top - height - 12, window.innerHeight - height - 14)) : Math.max(14, Math.min(rect.top, window.innerHeight - height - 14));
    setPosition({ left, top });
  }
  function closePanel(returnFocus = true) {
    if (batchBusy) return;
    setPanel(null);
    if (returnFocus) requestAnimationFrame(() => {
      if (triggerRef.current?.isConnected && triggerRef.current.getClientRects().length) triggerRef.current.focus({ preventScroll: true });
      else sidebarRef.current?.querySelector<HTMLButtonElement>('.library-view-toggle')?.focus({ preventScroll: true });
    });
  }
  function openPanel(next: LibraryPanel, trigger?: HTMLButtonElement, keyboard = false) {
    if (batchBusy) return;
    if (panel === next) { closePanel(); return; }
    if (trigger && !panelRef.current?.contains(trigger)) triggerRef.current = trigger;
    setKeyboardPanel(keyboard); placePanel(triggerRef.current); setPanel(next);
  }
  useEffect(() => {
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      placePanel();
      const target = panel === 'search' ? panelRef.current?.querySelector<HTMLInputElement>('#library-search') : panelRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]), select, [data-panel-initial], button:not(.library-panel-close):not(:disabled)');
      (target ?? panelRef.current)?.focus({ preventScroll: true });
    });
    const resize = () => placePanel();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || (target instanceof Element && target.closest('[data-library-tool]'))) return;
      // Batch controls remain available while selecting rows in the list.
      if (panel === 'batch' && resultsRef.current?.contains(target)) return;
      const receivesFocus = target instanceof Element && !!target.closest('button, a, input, select, textarea, summary, [tabindex]');
      closePanel(!receivesFocus);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closePanel(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    window.addEventListener('resize', resize); window.addEventListener('scroll', resize, true);
    const observer = new ResizeObserver(resize); if (panelRef.current) observer.observe(panelRef.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize); window.removeEventListener('scroll', resize, true); };
    // Polling and input updates must not refocus or remount an open panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, batchBusy]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const trigger = [...(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('[data-library-tool="search"]') ?? [])].find(button => button.getClientRects().length);
      if (!trigger) return;
      event.preventDefault(); triggerRef.current = trigger; setKeyboardPanel(true); placePanel(trigger); setPanel('search');
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLInputElement>('#library-search')?.focus({ preventScroll: true }));
    };
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    const pending = pendingPage.current;
    if (!pending) return;
    if (pending.filterKey !== filterKey) { pendingPage.current = null; return; }
    if (loading || !listing || listing.page !== pending.page) return;
    pendingPage.current = null;
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [listing, loading, filterKey]);
  function changePage(page: number) { pendingPage.current = { page, filterKey }; onFilter({ page }); }
  useEffect(() => { setSelectedIds([]); }, [filterKey]);
  const collectionName = filters.collectionId === 'none' ? 'Unsorted' : library?.collections.find(collection => collection.id === filters.collectionId)?.name;
  const filterDescription = [collectionName, search.trim() ? `“${search.trim()}”` : '', filters.platform ? platformName(filters.platform) : '', filters.tag ? `#${filters.tag}` : ''].filter(Boolean).join(' · ');
  const filtered = !!(search.trim() || filters.platform || filters.favorite || filters.tag || filters.collectionId || filters.view !== 'all');
  const viewLabel = filters.favorite ? 'Favourites' : ({ all: 'All items', inbox: 'Inbox', reviewed: 'Reviewed', trash: 'Trash' })[filters.view];
  const rangeStart = listing?.total ? (listing.page - 1) * listing.pageSize + 1 : 0;
  const rangeEnd = listing ? Math.min(listing.page * listing.pageSize, listing.total) : 0;
  const tool = (name: 'theme' | 'search' | 'collections' | 'filters' | 'tools', label: string, icon: string) => <button key={name} type="button" className="library-rail-button" data-library-tool={name} aria-expanded={panel === name} aria-controls="library-tool-panel" onClick={event => openPanel(name, event.currentTarget, event.detail === 0)}><CliptextIcon name={icon} size={20} /><span>{label}</span></button>;
  const views = <nav className="library-views" aria-label="Library views">{([
    ['all', 'document', 'All items', library?.stats.total], ['inbox', 'inbox', 'Inbox', library?.stats.inbox], ['reviewed', 'check', 'Reviewed', library?.stats.reviewed], ['trash', 'trash', 'Trash', library?.stats.trash],
  ] as const).map(([view, icon, label, count]) => <button key={view} type="button" className={filters.view === view && !filters.favorite ? 'is-active' : ''} aria-pressed={filters.view === view && !filters.favorite} onClick={() => { onFilter({ view, favorite: false, collectionId: '' }); closePanel(); }}><CliptextIcon name={icon} size={16} /><span>{label}</span><small>{count?.toLocaleString() ?? ''}</small></button>)}<button type="button" className={filters.favorite ? 'is-active' : ''} aria-pressed={filters.favorite} onClick={() => { onFilter({ favorite: !filters.favorite, view: 'all' }); closePanel(); }}><CliptextIcon name="star" size={16} /><span>Favourites</span><small>{library?.stats.favorites.toLocaleString() ?? ''}</small></button></nav>;

  return <aside ref={sidebarRef} className="library-sidebar" aria-label="Saved library">
    <nav className="library-rail" aria-label="Library tools">{tool('search', 'Search', 'search')}{tool('collections', 'Collections', 'folder')}{tool('filters', 'Filters', 'filter')}{tool('theme', 'Theme', 'palette')}<span className="library-rail-spacer" />{tool('tools', 'Tools', 'more')}<a className="library-rail-button" href="/setup" aria-label="Sharing setup" title="Sharing setup"><CliptextIcon name="guidebook" size={20} /><span>Sharing</span></a></nav>
    <div className="history-sidebar library-list-panel">
      <div className="history-heading"><h2 id="library-heading" tabIndex={-1}>Library</h2></div>
      <div className="library-list-meta"><button className="library-view-toggle" type="button" data-library-tool="views" aria-expanded={panel === 'views'} aria-controls="library-tool-panel" onClick={event => openPanel('views', event.currentTarget, event.detail === 0)}>{viewLabel}<CliptextIcon name="chevronDown" size={13} /></button><span className="library-total" role="status" aria-live="polite">{loading && !listing ? 'Loading…' : listing ? `${listing.total.toLocaleString()} ${listing.total === 1 ? 'item' : 'items'}` : ''}</span></div>
      {filterDescription && <div className="library-active-filter"><span title={filterDescription}>{filterDescription}</span><button type="button" aria-label="Clear filters" onClick={onReset}><CliptextIcon name="close" size={13} /></button></div>}
      {selecting && <div className="library-selection-bar"><label className="select-page"><input type="checkbox" disabled={batchBusy || !listing?.jobs.length} checked={!!listing?.jobs.length && listing.jobs.every(job => selectedIds.includes(job.id))} onChange={event => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...(listing?.jobs.map(job => job.id) ?? [])])] : selectedIds.filter(id => !listing?.jobs.some(job => job.id === id)))} />This page</label><button type="button" className="text-button" data-library-tool="batch" onClick={event => openPanel('batch', event.currentTarget, event.detail === 0)}>{selectedIds.length} selected<CliptextIcon name="more" size={15} /></button><button type="button" className="text-button" disabled={batchBusy} onClick={() => { setSelecting(false); setSelectedIds([]); closePanel(); }}>Done</button></div>}
      {error && <div className="library-error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={onReload}>Try again</button></div>}
      <div className="library-results" ref={resultsRef} aria-busy={loading}>
        {loading && !listing ? <div className="library-skeleton" aria-hidden="true">{[0, 1, 2].map(index => <span key={index} />)}</div> : listing?.jobs.length ? <div className="history-list">{listing.jobs.map(job => <div className={`history-row ${selecting ? 'is-selecting' : ''}`} key={job.id}>{selecting && <label className="history-selection"><input type="checkbox" aria-label={`Select ${jobLabel(job)}`} disabled={batchBusy} checked={selectedIds.includes(job.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, job.id] : ids.filter(id => id !== job.id))} /></label>}<button type="button" className={`history-item ${selectedId === job.id ? 'is-selected' : ''}`} onClick={() => onSelect(job.id)} aria-current={selectedId === job.id ? 'true' : undefined} title={jobLabel(job)}>
          <div className="history-item-content">{showThumbnails && <LibraryThumbnail job={job} />}<div className="history-item-copy"><h3><Highlight value={jobLabel(job)} query={filters.q} /></h3>{filters.q && job.preview && <p className="history-preview"><Highlight value={job.preview} query={filters.q} /></p>}<div className="history-item-bottom"><span>{platformName(job.platform)} · {timeLabel(job.createdAt)}</span>{jobExtent(job) && <span className="history-extent">{jobExtent(job)}</span>}{job.favorite && <CliptextIcon name="star" size={12} />}</div>{job.status !== 'completed' && <div className="history-item-state"><span className={`job-dot status-${job.status}`} />{jobStatusLabel(job)}</div>}</div></div>
        </button></div>)}</div> : <div className="history-empty"><CliptextIcon name={filtered ? 'search' : 'clock'} size={20} /><p>{filtered ? 'No matching items.' : 'No items yet.'}</p>{filtered && <button type="button" className="text-button" onClick={onReset}>Show all items</button>}</div>}
      </div>
      {listing && listing.total > 0 && <nav className="library-pagination" aria-label="Library pages"><p>{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {listing.total.toLocaleString()}</p><div><button type="button" className="icon-button" disabled={loading || listing.page <= 1} aria-label="Previous library page" onClick={() => changePage(listing.page - 1)}><CliptextIcon name="chevronLeft" size={16} /></button><span>{listing.page} / {Math.max(1, listing.totalPages)}</span><button type="button" className="icon-button" disabled={loading || listing.page >= listing.totalPages} aria-label="Next library page" onClick={() => changePage(listing.page + 1)}><CliptextIcon name="chevronRight" size={16} /></button></div></nav>}
      <nav className="library-mobile-tools" aria-label="Library tools">{tool('search', 'Search', 'search')}{tool('collections', 'Collections', 'folder')}{tool('tools', 'Tools', 'more')}</nav>
    </div>
    {panel && <div ref={panelRef} id="library-tool-panel" className={`library-tool-panel ${keyboardPanel ? 'is-keyboard' : ''} ${panel === 'theme' ? 'is-theme-panel' : ''}`} role="dialog" aria-label={panelTitle[panel]} tabIndex={-1} style={position}>
      <div className="library-panel-heading"><h3>{panelTitle[panel]}</h3><button type="button" className="icon-button library-panel-close" aria-label={`Close ${panelTitle[panel]}`} disabled={batchBusy} onClick={() => closePanel()}><CliptextIcon name="close" size={16} /></button></div>
      {panel === 'search' && <div className="library-search-controls"><label className="screen-reader-status" htmlFor="library-search">Search your library</label><div className="library-search"><CliptextIcon name="search" size={16} /><input id="library-search" type="search" placeholder="Search transcripts…" value={search} maxLength={200} onChange={event => onSearch(event.target.value)} autoComplete="off" />{search && <button type="button" className="icon-button" onClick={() => onSearch('')} aria-label="Clear search"><CliptextIcon name="close" size={14} /></button>}</div><div className="library-search-result-count">{listing ? `${listing.total.toLocaleString()} ${listing.total === 1 ? 'result' : 'results'}` : ''}<kbd>⌘ K</kbd></div></div>}
      {panel === 'collections' && <><button className={`library-panel-row ${!filters.collectionId ? 'is-active' : ''}`} type="button" aria-pressed={!filters.collectionId} onClick={() => { onFilter({ collectionId: '', view: 'all' }); closePanel(); }}><CliptextIcon name="folder" size={16} />All collections</button><Collections collections={library?.collections ?? []} selected={filters.collectionId} onSelect={id => { onFilter({ collectionId: id, view: 'all' }); closePanel(); }} onChanged={onCollectionChanged} /></>}
      {(panel === 'filters' || panel === 'views') && <>{panel === 'filters' && <div className="library-filter-grid"><label htmlFor="platform-filter">Platform<select id="platform-filter" value={filters.platform} onChange={event => onFilter({ platform: event.target.value as LibraryFilters['platform'] })}><option value="">All platforms</option><option value="tiktok">TikTok</option><option value="youtube">YouTube</option><option value="instagram">Instagram</option></select></label><label htmlFor="tag-filter">Tag<select id="tag-filter" value={filters.tag} onChange={event => onFilter({ tag: event.target.value })}><option value="">All tags</option>{filters.tag && !library?.tags.some(tag => tag.name === filters.tag) && <option value={filters.tag}>{filters.tag}</option>}{library?.tags.map(tag => <option value={tag.name} key={tag.name}>{tag.name} ({tag.count})</option>)}</select></label></div>}{views}</>}
      {panel === 'tools' && <div className="library-tool-actions">{!showThumbnails && <button type="button" className="library-panel-row" onClick={event => openPanel('theme', undefined, event.detail === 0)}><CliptextIcon name="palette" size={17} />Theme</button>}{!showThumbnails && <button type="button" className="library-panel-row" onClick={event => openPanel('filters', undefined, event.detail === 0)}><CliptextIcon name="filter" size={17} />Filters</button>}<button type="button" className="library-panel-row" onClick={event => openPanel('export', undefined, event.detail === 0)}><CliptextIcon name="download" size={17} />Export</button><button type="button" className="library-panel-row" onClick={event => openPanel('backup', undefined, event.detail === 0)}><CliptextIcon name="document" size={17} />Backups</button><button type="button" className="library-panel-row" aria-pressed={selecting} disabled={batchBusy} onClick={() => { setSelecting(!selecting); setSelectedIds([]); closePanel(); }}><CliptextIcon name="check" size={17} />{selecting ? 'Done selecting' : 'Select items'}</button><button type="button" className="library-panel-row" onClick={() => { onFilter({ view: 'trash', favorite: false, collectionId: '' }); closePanel(); }}><CliptextIcon name="trash" size={17} />Trash</button>{!showThumbnails && <a className="library-panel-row" href="/setup"><CliptextIcon name="guidebook" size={17} />Sharing setup</a>}</div>}
      {panel === 'theme' && <ThemePanel />}
      {panel === 'export' && <LibraryExport filters={{ ...filters, q: search }} collections={library?.collections ?? []} selectedIds={selectedIds} onClose={() => closePanel()} />}
      {panel === 'backup' && <LibraryBackup onRestored={onReload} />}
      {panel === 'batch' && <BatchActions ids={selectedIds} collections={library?.collections ?? []} trash={filters.view === 'trash'} onBusy={setBatchBusy} onExport={() => openPanel('export', undefined, keyboardPanel)} onDone={failedIds => { setSelectedIds(failedIds); onReload(); }} />}
    </div>}
  </aside>;
}

export function JobOrganization({ job, collections, saving, error, onSave, onTag }: { job: FullJob; collections: LibraryData['collections']; saving: boolean; error: string; onSave: (changes: JobChanges) => Promise<boolean>; onTag: (tag: string) => void }) {
  const [tags, setTags] = useState(job.tags.join(', '));
  const storedTags = job.tags.join(', ');
  const tagsInputRef = useRef<HTMLInputElement>(null);
  const tagListRef = useRef<HTMLDivElement>(null);
  const pendingRemoval = useRef<{ tag: string; draft: string; index: number; keyboard: boolean; focused: Element | null } | null>(null);
  useEffect(() => {
    const removal = pendingRemoval.current;
    setTags(removal ? removal.draft.split(',').map((tag) => tag.trim()).filter((tag) => tag && tag.toLocaleLowerCase() !== removal.tag.toLocaleLowerCase()).join(', ') : storedTags);
    if (removal?.keyboard && (document.activeElement === removal.focused || document.activeElement === document.body)) {
      const buttons = tagListRef.current?.querySelectorAll<HTMLButtonElement>('.tag-remove');
      const next = buttons?.[Math.min(removal.index, buttons.length - 1)];
      (next ?? tagsInputRef.current)?.focus({ preventScroll: true });
    }
    pendingRemoval.current = null;
  }, [job.id, storedTags]);
  async function saveTags(event: FormEvent) { event.preventDefault(); if (!saving) await onSave({ tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) }); }
  async function removeTag(tag: string, keyboard: boolean) {
    if (saving || pendingRemoval.current) return;
    pendingRemoval.current = { tag, draft: tags, index: job.tags.indexOf(tag), keyboard, focused: document.activeElement };
    if (!await onSave({ tags: job.tags.filter((value) => value !== tag) })) pendingRemoval.current = null;
  }
  return <section className="job-organization" aria-label="Organize this item">
    <div className="job-organization-top"><button type="button" className={`button-quiet favourite-button ${job.favorite ? 'is-favourite' : ''}`} aria-pressed={job.favorite} disabled={saving} onClick={() => void onSave({ favorite: !job.favorite })}><CliptextIcon name="star" size={17} />{job.favorite ? 'Favourited' : 'Favourite'}</button><label htmlFor="job-collection" className="job-collection-label"><CliptextIcon name="folder" size={15} /><span className="screen-reader-status">Collection for this item</span><select id="job-collection" aria-label="Collection for this item" value={job.collectionId ?? ''} disabled={saving} onChange={(event) => void onSave({ collectionId: event.target.value || null })}><option value="">No collection</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label></div>
    <form className="job-tags-form" onSubmit={saveTags}><label htmlFor="job-tags">Tags</label><div><input ref={tagsInputRef} id="job-tags" value={tags} maxLength={500} placeholder="Add tags…" title="Separate tags with commas" disabled={saving} onChange={(event) => setTags(event.target.value)} /><button type="submit" className="text-button" disabled={saving || tags === storedTags}>{saving ? 'Saving…' : 'Save tags'}</button></div></form>
    {job.tags.length > 0 && <div ref={tagListRef} className="job-tag-list" aria-label="Tags for this item">{job.tags.map((tag) => <span className="job-tag" key={tag}><button type="button" className="tag-filter" onClick={() => onTag(tag)} aria-label={`Filter by tag ${tag}`}>{tag}</button><button type="button" className="tag-remove" disabled={saving} onClick={(event) => void removeTag(tag, event.detail === 0)} aria-label={`Remove tag ${tag} from this item`} title={`Remove ${tag}`}><CliptextIcon name="close" size={12} /></button></span>)}</div>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
