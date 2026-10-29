import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CliptextIcon as Icon, jobExtent, jobLabel, jobStatusLabel, platformName, timeLabel } from '../../app/library-controls';
import ReaderControls from '../../app/reader-controls';
import ImagePostText from '../../app/image-post-text';
import ThemePanel from '../../app/theme-panel';
import { extractVideoUrl } from '../../lib/video';
import { isImagePost, readableTranscript } from '../../lib/transcript';
import { shortSummary } from '../../lib/library-upgrade';
import { PhoneStorage } from './storage';
import { PhoneSyncClient, type ConnectionState } from './sync';
import { EMPTY_SNAPSHOT, type LibrarySnapshot, type PhoneJob } from './types';

type Panel = 'search' | 'collections' | 'filters' | 'theme' | 'tools' | 'connection' | 'queue';
const titles: Record<Panel, string> = { search: 'Search', collections: 'Collections', filters: 'Filters', theme: 'Theme', tools: 'Tools', connection: 'Connection', queue: 'Queue' };
const initialFilters = { search: '', collection: '', platform: '', tag: '', favorites: false, reviewed: '' };
function sourceUrl(value: string) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } }

function Transcript({ job, collections, onTag, announce }: { job: PhoneJob; collections: LibrarySnapshot['collections']; onTag: (tag: string) => void; announce: (text: string) => void }) {
  const [takeaways, setTakeaways] = useState(false);
  const text = readableTranscript(job);
  async function copy() {
    try { await navigator.clipboard.writeText(text); announce('Copied.'); }
    catch { announce('Copy failed. Select the transcript text to copy it.'); }
  }
  function download() {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${jobLabel({ ...job, preview: '' }).replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 90) || 'transcript'}.txt`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  const collection = collections.find(item => item.id === job.collectionId);
  return <>
    <div className="result-heading">
      {job.status !== 'completed' && <div className="result-heading-top"><div className="result-status"><span className={`job-dot status-${job.status}`} />{jobStatusLabel({ ...job, preview: '' })}</div></div>}
      <div className="result-identity"><div className="result-title-group"><h2>{jobLabel({ ...job, preview: '' })}</h2><div className="video-meta">
        {job.creator && <span>{job.platform === 'youtube' || job.creator.startsWith('@') ? job.creator : `@${job.creator}`}</span>}
        <a href={sourceUrl(job.url)} target="_blank" rel="noreferrer">Source<Icon name="external" size={13} /></a><span className="platform-badge">{platformName(job.platform)}</span>
        {jobExtent({ ...job, preview: '' }) && <span className="duration">{jobExtent({ ...job, preview: '' })}</span>}{job.language && <span className="language">{job.language.toUpperCase()}</span>}<span>{timeLabel(job.createdAt)}</span>
      </div></div></div>
    </div>
    {job.insights?.summary && <section className="job-insights" aria-label="Summary"><div className="insights-heading"><h3>Summary</h3></div><p className="summary-text" title={shortSummary(job.insights.summary)}>{shortSummary(job.insights.summary)}</p></section>}
    <ReaderControls key={job.id} organization={collection || job.tags.length ? <div className="pwa-organization">{collection && <span className="pwa-collection"><Icon name="folder" size={15} />{collection.name}</span>}<div className="job-tags">{job.tags.map(tag => <button type="button" className="tag" key={tag} onClick={() => onTag(tag)}>{tag}</button>)}</div></div> : undefined} tools={<div className="reader-tool-actions">
      <div className="reader-option-toggles">{job.insights?.takeaways.length ? <><button type="button" className={`timestamp-toggle ${takeaways ? 'is-active' : ''}`} role="switch" aria-checked={takeaways} aria-controls="key-takeaways" onClick={() => setTakeaways(value => !value)}><span className="switch-track"><span /></span>Key takeaways</button><ul id="key-takeaways" className="takeaways insight-takeaway-list" hidden={!takeaways}>{job.insights.takeaways.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}</div>
      <div className="reader-action-icons"><button type="button" className="reader-icon-action" disabled={!text} aria-label="Export transcript as text file" title="Export as .txt" onClick={download}><Icon name="download" size={18} /></button></div>
    </div>} actions={<button type="button" className="button-quiet" disabled={!text} onClick={() => void copy()}><Icon name="copy" size={16} />Copy</button>} />
    {job.status === 'failed' && <div className="failed-state" role="alert"><h3>This link couldn’t be processed.</h3><p>{job.error || 'Check this item on your Mac.'}</p></div>}
    {job.status !== 'completed' && job.status !== 'failed' && <div className="processing-state"><div className="processing-heading"><h3>{job.status === 'queued' ? 'Waiting for your Mac' : job.status === 'downloading' ? 'Retrieving post' : isImagePost(job) ? 'Reading images…' : 'Transcribing…'}</h3></div><div className="progress-track" role="progressbar" aria-label="Text extraction progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, job.progress))}><span style={{ width: `${Math.max(4, Math.min(100, job.progress))}%` }} /></div></div>}
    {job.status === 'completed' && <div className="transcript-content">{isImagePost(job) && job.pages?.length ? <ImagePostText pages={job.pages} carousel={job.contentKind === 'carousel'} allText={false} /> : job.transcript ? job.transcript.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className="no-speech">{isImagePost(job) ? 'No text detected.' : 'No speech detected.'}</p>}</div>}
    {job.notes && <section className="job-notes pwa-notes" aria-labelledby="notes-heading"><h3 id="notes-heading">Notes</h3><p>{job.notes}</p></section>}
  </>;
}

export default function PhoneApp({ pairingCode = '' }: { pairingCode?: string }) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [state, setState] = useState<ConnectionState>('syncing');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'library' | 'transcript'>('library');
  const [composer, setComposer] = useState(false);
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [position, setPosition] = useState({ left: 14, top: 100 });
  const [filters, setFilters] = useState(initialFilters);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [offlineReady, setOfflineReady] = useState(false);
  const [shortcutDownloads, setShortcutDownloads] = useState(false);
  const [shellError, setShellError] = useState('');
  const storageRef = useRef<PhoneStorage | null>(null);
  const clientRef = useRef<PhoneSyncClient | null>(null);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mounted.current = true;
    let stop = false;
    const storage = new PhoneStorage(); storageRef.current = storage;
    const client = new PhoneSyncClient(storage, {
      changed: value => { if (!stop) setSnapshot(value); },
      session: value => { if (!stop) setShortcutDownloads(value.shortcutDownloads === true); },
      state: (value, message = '') => { if (!stop) { setState(value); setConnectionMessage(message); } },
    }); clientRef.current = client;
    async function boot() {
      try {
        const saved = await storage.snapshot(); if (stop) return;
        setSnapshot(saved); setLoading(false);
        if (pairingCode && saved.libraryId) {
          // A QR link must never replace an existing offline library or outbox
          // without the same explicit confirmation used by the Connect form.
          setCode(pairingCode); setPanel('connection'); setState('reconnect');
        } else if (pairingCode) {
          setPairing(true);
          try { await client.pair(pairingCode); }
          catch (error) { setPairError(error instanceof Error ? error.message : 'This pairing code did not work.'); setPanel('connection'); setState('reconnect'); }
          finally { if (!stop) setPairing(false); }
        } else await client.sync();
        if (!stop) void navigator.storage?.persist?.().catch(() => false);
      } catch (error) { if (!stop) { setLoading(false); setStorageError(error instanceof Error ? error.message : 'Phone storage is unavailable.'); } }
    }
    void boot();
    const syncVisible = () => { if (document.visibilityState === 'visible') void client.sync(); };
    document.addEventListener('visibilitychange', syncVisible); window.addEventListener('focus', syncVisible); window.addEventListener('online', syncVisible);
    const timer = setInterval(syncVisible, 30_000);
    return () => { stop = true; mounted.current = false; clearInterval(timer); client.cancel(); void storage.close(); document.removeEventListener('visibilitychange', syncVisible); window.removeEventListener('focus', syncVisible); window.removeEventListener('online', syncVisible); };
  }, [pairingCode]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setShellError('Offline opening is unavailable in this browser.'); return; }
    let active = true;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => { if (active) setOfflineReady(true); }).catch(() => { if (active) setShellError('Offline setup did not finish. Reload while connected to your Mac.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!snapshot.jobs.some(job => job.id === selectedId)) setSelectedId(snapshot.jobs[0]?.id ?? null);
  }, [snapshot.jobs, selectedId]);
  useEffect(() => { if (composer) requestAnimationFrame(() => inputRef.current?.focus()); }, [composer]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: 0 }); }, [selectedId]);
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(''), 5000); return () => clearTimeout(timer);
  }, [announcement]);

  function closePanel(focus = true) { setPanel(null); if (focus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true })); }
  function placePanel() {
    const rect = triggerRef.current?.getBoundingClientRect(); const mobile = window.matchMedia('(max-width: 760px)').matches;
    const width = Math.min(mobile ? 360 : 320, window.innerWidth - 28), height = panelRef.current?.offsetHeight ?? 340;
    setPosition({ left: Math.max(14, Math.min(mobile ? (window.innerWidth - width) / 2 : (rect?.right ?? 80) + 14, window.innerWidth - width - 14)), top: Math.max(14, Math.min(mobile ? (rect?.top ?? window.innerHeight - 30) - height - 12 : rect?.top ?? 100, window.innerHeight - height - 14)) });
  }
  function openPanel(value: Panel, trigger?: HTMLElement) { if (panel === value) { closePanel(); return; } if (trigger) triggerRef.current = trigger; setPanel(value); }
  useEffect(() => {
    if (!panel) return;
    const frame = requestAnimationFrame(() => { placePanel(); (panel === 'search' ? panelRef.current?.querySelector<HTMLInputElement>('input') : panelRef.current?.querySelector<HTMLElement>('button:not(.library-panel-close), input'))?.focus({ preventScroll: true }); });
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!panelRef.current?.contains(target) && !(target instanceof Element && target.closest('[data-library-tool]'))) closePanel(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('resize', placePanel);
    const observer = new ResizeObserver(placePanel); if (panelRef.current) observer.observe(panelRef.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', placePanel); };
  }, [panel]);

  const active = snapshot.jobs.find(job => job.id === selectedId);
  const jobs = useMemo(() => {
    const terms = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return snapshot.jobs.filter(job => (!filters.collection || (filters.collection === 'none' ? !job.collectionId : job.collectionId === filters.collection)) && (!filters.platform || job.platform === filters.platform) && (!filters.tag || job.tags.includes(filters.tag)) && (!filters.favorites || job.favorite) && (!filters.reviewed || (filters.reviewed === 'reviewed' ? !!job.reviewedAt : !job.reviewedAt)) && terms.every(term => `${job.title ?? ''}\n${job.creator ?? ''}\n${job.transcript ?? ''}\n${job.notes ?? ''}\n${job.tags.join(' ')}`.toLocaleLowerCase().includes(term)));
  }, [snapshot.jobs, filters]);
  const tags = [...new Set(snapshot.jobs.flatMap(job => job.tags))].sort();
  const filterDescription = [filters.search.trim(), filters.collection === 'none' ? 'Unsorted' : snapshot.collections.find(item => item.id === filters.collection)?.name, filters.platform ? platformName(filters.platform as PhoneJob['platform']) : '', filters.tag ? `#${filters.tag}` : '', filters.favorites ? 'Favourites' : '', filters.reviewed === 'reviewed' ? 'Reviewed' : filters.reviewed ? 'Inbox' : ''].filter(Boolean).join(' · ');
  function select(id: string) { setSelectedId(id); setMobileView('transcript'); closePanel(false); }
  function tool(value: Panel, label: string, icon: string) { return <button type="button" key={value} className="library-rail-button" data-library-tool={value} aria-expanded={panel === value} aria-controls="library-tool-panel" onClick={event => openPanel(value, event.currentTarget)}><Icon name={icon} size={20} /><span>{label}{value === 'tools' && snapshot.outbox.length ? <span className="pwa-queue-dot" /> : null}</span></button>; }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!snapshot.libraryId || saving) return;
    const url = extractVideoUrl(input);
    if (!url) { setFormError('Paste a TikTok, YouTube, or Instagram post link.'); return; }
    setSaving(true); setFormError('');
    try {
      await storageRef.current!.enqueue(snapshot.libraryId, url);
      setSnapshot(await storageRef.current!.snapshot());
      setInput(''); setComposer(false); setAnnouncement('Link saved to Queue.');
      void clientRef.current?.sync();
    } catch (error) { setFormError(error instanceof Error ? error.message : 'The link could not be saved on this phone.'); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function pair(event: FormEvent) {
    event.preventDefault(); if (pairing || !code.trim()) return;
    let value = code.trim();
    try { const url = new URL(value); if (url.origin !== location.origin) throw new Error('Open the pairing link from your Mac.'); value = new URLSearchParams(url.hash.slice(1)).get('pair') ?? ''; } catch (error) { if (/^https?:/i.test(value)) { setPairError(error instanceof Error ? error.message : 'Check the pairing link.'); return; } }
    if (snapshot.libraryId && !window.confirm('Pair again? If this is a different Mac library, its copy will replace the saved transcripts and queued links on this phone.')) return;
    setPairing(true); setPairError('');
    try { await clientRef.current!.pair(value); setCode(''); closePanel(false); }
    catch (error) { setPairError(error instanceof Error ? error.message : 'Pairing failed. Create a new code on your Mac.'); }
    finally { if (mounted.current) setPairing(false); }
  }
  async function forget() {
    if (!window.confirm('Remove this phone’s saved transcripts and queued links? The library on your Mac stays saved.')) return;
    await clientRef.current?.forget(); setSelectedId(null); setComposer(false); setCode('');
  }
  const connection = <form className="pwa-connect" onSubmit={pair}><p>On your Mac: Sharing setup → iPhone → Pair iPhone.</p><label htmlFor="pair-code">Pairing code or link</label><textarea id="pair-code" value={code} onChange={event => { setCode(event.target.value); setPairError(''); }} rows={3} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4000} /><button type="submit" className="button-primary" disabled={pairing || !code.trim()}>{pairing ? 'Connecting…' : 'Connect'}</button>{pairError && <p className="field-error" role="alert">{pairError}</p>}</form>;

  return <div className="app-shell pwa-shell" data-mobile-view={mobileView}>
    <a className="skip-link" href={mobileView === 'library' ? '#library-heading' : '#transcript-result'}>Skip to {mobileView === 'library' ? 'library' : 'transcript'}</a>
    <header className="site-header" data-composer-open={composer}>
      <a className="wordmark" href="/" aria-label="Cliptext home" onClick={event => { event.preventDefault(); setMobileView('library'); }}><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span><span className="wordmark-label">Cliptext</span></a>
      <form id="link-composer" className="link-form" hidden={!composer} onSubmit={add}><label className="screen-reader-status" htmlFor="link-input">Post or video link</label><div className="link-field"><textarea ref={inputRef} id="link-input" value={input} onChange={event => { setInput(event.target.value); setFormError(''); }} rows={1} maxLength={4096} placeholder="Paste a post link…" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={!!formError} /><button className="button-primary" type="submit" disabled={!input.trim() || saving} aria-label="Save link"><Icon name="arrow" size={19} /></button></div>{formError && <p className="field-error" role="alert">{formError}</p>}</form>
      <div className="header-actions">{snapshot.libraryId && <button type="button" className={`button-quiet composer-toggle ${composer ? 'is-open' : ''}`} aria-expanded={composer} aria-controls="link-composer" onClick={() => setComposer(value => !value)}><Icon name={composer ? 'close' : 'plus'} size={16} />{!composer && 'Add a link'}</button>}<button type="button" className={`button-quiet pwa-sync engine-state ${state === 'synced' ? 'is-online' : 'is-offline'}`} disabled={state === 'syncing' || loading} aria-label={state === 'syncing' ? 'Syncing' : 'Sync library'} onClick={event => state === 'reconnect' ? openPanel('connection', event.currentTarget) : void clientRef.current?.sync()}><span className="status-dot" /><span>{state === 'syncing' ? 'Syncing…' : state === 'synced' ? 'Synced' : state === 'reconnect' ? 'Connect' : state === 'error' ? 'Retry' : 'Offline'}</span></button></div>
    </header>
    <nav className="mobile-library-tabs" aria-label="Workspace views"><button type="button" className={mobileView === 'transcript' ? 'is-active' : ''} aria-pressed={mobileView === 'transcript'} onClick={() => setMobileView('transcript')}><Icon name="document" size={17} />Transcript</button><button type="button" className={mobileView === 'library' ? 'is-active' : ''} aria-pressed={mobileView === 'library'} onClick={() => setMobileView('library')}><Icon name="folder" size={17} />Library<span>{snapshot.jobs.length}</span></button></nav>
    <main className="app-layout">
      <section className="workspace" aria-label="Transcript"><div className="transcript-frame"><section className="transcript-sheet" id="transcript-result" ref={transcriptRef} tabIndex={-1}>
        {active ? <Transcript key={active.id} job={active} collections={snapshot.collections} onTag={tag => { setFilters(current => ({ ...current, tag })); setMobileView('library'); }} announce={setAnnouncement} /> : <div className="result-empty"><div className="empty-mark" aria-hidden="true"><span /><span /><span /><span /></div><h2>{loading ? 'Loading…' : 'No transcript selected'}</h2><p>{snapshot.libraryId ? 'Choose an item from Library.' : 'Connect your Mac from Library.'}</p></div>}
      </section></div><p className="action-announcement" role="status" aria-live="polite">{announcement}</p></section>
      <aside className="library-sidebar" aria-label="Saved library"><nav className="library-rail" aria-label="Library tools">{tool('search', 'Search', 'search')}{tool('collections', 'Collections', 'folder')}{tool('filters', 'Filters', 'filter')}{tool('theme', 'Theme', 'palette')}<span className="library-rail-spacer" />{tool('tools', 'Tools', 'more')}{tool('connection', 'Connection', 'guidebook')}</nav><div className="history-sidebar library-list-panel">
        <div className="history-heading"><h2 id="library-heading" tabIndex={-1}>Library</h2></div><div className="library-list-meta"><span>All items</span><span className="library-total">{jobs.length} {jobs.length === 1 ? 'item' : 'items'}</span></div>
        {filterDescription && <div className="library-active-filter"><span>{filterDescription}</span><button type="button" aria-label="Clear filters" onClick={() => setFilters(initialFilters)}><Icon name="close" size={13} /></button></div>}
        {storageError && <div className="library-error" role="alert"><p>{storageError}</p></div>}
        {state === 'reconnect' && snapshot.libraryId && <div className="library-error" role="status"><p>{connectionMessage || 'Pair again to resume sync. Saved transcripts are still available.'}</p><button type="button" className="text-button" data-library-tool="connection" onClick={event => openPanel('connection', event.currentTarget)}>Connect</button></div>}
        {state === 'error' && <div className="library-error" role="alert"><p>{connectionMessage}</p></div>}
        {shellError && <div className="library-error" role="alert"><p>{shellError}</p></div>}
        <div className="library-results" aria-busy={loading}>{loading ? <div className="library-skeleton" aria-hidden="true"><span /><span /><span /></div> : !snapshot.libraryId ? <div className="pwa-pair-empty"><h3>Connect your Mac</h3>{connection}</div> : jobs.length ? <div className="history-list">{jobs.map(job => <div className="history-row" key={job.id}><button type="button" className={`history-item ${selectedId === job.id ? 'is-selected' : ''}`} onClick={() => select(job.id)} aria-current={selectedId === job.id ? 'true' : undefined}><div className="history-item-content"><div className="history-item-copy"><h3>{jobLabel({ ...job, preview: '' })}</h3><div className="history-item-bottom"><span>{platformName(job.platform)} · {timeLabel(job.createdAt)}</span>{jobExtent({ ...job, preview: '' }) && <span className="history-extent">{jobExtent({ ...job, preview: '' })}</span>}{job.favorite && <Icon name="star" size={12} />}</div>{job.status !== 'completed' && <div className="history-item-state"><span className={`job-dot status-${job.status}`} />{jobStatusLabel({ ...job, preview: '' })}</div>}</div></div></button></div>)}</div> : <div className="history-empty"><Icon name="search" size={20} /><p>{snapshot.jobs.length ? 'No matching items.' : 'No items yet.'}</p>{snapshot.jobs.length > 0 && <button type="button" className="text-button" onClick={() => setFilters(initialFilters)}>Show all items</button>}</div>}</div>
        <nav className="library-mobile-tools" aria-label="Library tools">{tool('search', 'Search', 'search')}{tool('collections', 'Collections', 'folder')}{tool('tools', 'Tools', 'more')}</nav>
      </div></aside>
    </main>
    {panel && <div id="library-tool-panel" ref={panelRef} role="dialog" aria-label={titles[panel]} className={`library-tool-panel pwa-tool-panel ${panel === 'theme' ? 'is-theme-panel' : ''}`} tabIndex={-1} style={position}>
      <div className="library-panel-heading"><h3>{titles[panel]}</h3><button type="button" className="icon-button library-panel-close" aria-label={`Close ${titles[panel]}`} onClick={() => closePanel()}><Icon name="close" size={16} /></button></div>
      {panel === 'search' && <div className="library-search-controls"><label className="screen-reader-status" htmlFor="library-search">Search your library</label><div className="library-search"><Icon name="search" size={16} /><input id="library-search" type="search" value={filters.search} placeholder="Search transcripts…" autoComplete="off" maxLength={200} onChange={event => setFilters(current => ({ ...current, search: event.target.value }))} /></div><p className="library-search-result-count">{jobs.length} results</p></div>}
      {panel === 'collections' && <><button type="button" className={`library-panel-row ${!filters.collection ? 'is-active' : ''}`} onClick={() => { setFilters(current => ({ ...current, collection: '' })); closePanel(); }}>All collections</button>{[{ id: 'none', name: 'Unsorted' }, ...snapshot.collections].map(item => <button key={item.id} type="button" className={`library-panel-row ${filters.collection === item.id ? 'is-active' : ''}`} onClick={() => { setFilters(current => ({ ...current, collection: item.id })); closePanel(); }}><Icon name="folder" size={16} />{item.name}<small className="pwa-row-count">{snapshot.jobs.filter(job => item.id === 'none' ? !job.collectionId : job.collectionId === item.id).length}</small></button>)}</>}
      {panel === 'filters' && <div className="library-filter-grid pwa-filters"><label htmlFor="platform-filter">Platform<select id="platform-filter" value={filters.platform} onChange={event => setFilters(current => ({ ...current, platform: event.target.value }))}><option value="">All platforms</option><option value="tiktok">TikTok</option><option value="youtube">YouTube</option><option value="instagram">Instagram</option></select></label><label htmlFor="tag-filter">Tag<select id="tag-filter" value={filters.tag} onChange={event => setFilters(current => ({ ...current, tag: event.target.value }))}><option value="">All tags</option>{tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label><label htmlFor="review-filter">View<select id="review-filter" value={filters.reviewed} onChange={event => setFilters(current => ({ ...current, reviewed: event.target.value }))}><option value="">All items</option><option value="inbox">Inbox</option><option value="reviewed">Reviewed</option></select></label><button type="button" className={`library-panel-row ${filters.favorites ? 'is-active' : ''}`} aria-pressed={filters.favorites} onClick={() => setFilters(current => ({ ...current, favorites: !current.favorites }))}><Icon name="star" size={16} />Favourites</button></div>}
      {panel === 'theme' && <ThemePanel />}
      {panel === 'tools' && <><button className="library-panel-row" type="button" disabled={state === 'syncing'} onClick={() => { void clientRef.current?.sync(); closePanel(); }}><Icon name="restore" size={17} />Sync</button><button className="library-panel-row" type="button" onClick={() => setPanel('queue')}><Icon name="inbox" size={17} />Queue<small className="pwa-row-count">{snapshot.outbox.length}</small></button><button className="library-panel-row pwa-mobile-only" type="button" onClick={() => setPanel('filters')}><Icon name="filter" size={17} />Filters</button><button className="library-panel-row pwa-mobile-only" type="button" onClick={() => setPanel('theme')}><Icon name="palette" size={17} />Theme</button><button className="library-panel-row" type="button" onClick={() => setPanel('connection')}><Icon name="guidebook" size={17} />Connection</button></>}
      {panel === 'queue' && <div className="pwa-queue">{snapshot.outbox.length ? snapshot.outbox.map(link => <div key={link.requestId} className="pwa-queue-entry"><p>{link.url}</p>{link.error && <p className="field-error">{link.error}</p>}<button type="button" className="reader-icon-action" disabled={state === 'syncing'} aria-label={`Remove queued link ${link.url}`} onClick={async () => { await storageRef.current!.acknowledge(snapshot.libraryId!, link.requestId); setSnapshot(await storageRef.current!.snapshot()); }}><Icon name="trash" size={17} /></button></div>) : <p>Queue is empty.</p>}<button type="button" className="text-button" disabled={state === 'syncing' || !snapshot.outbox.length} onClick={() => void clientRef.current?.sync()}>Sync</button></div>}
      {panel === 'connection' && <>{snapshot.libraryId && <div className="pwa-connection-status"><p>{state === 'synced' ? 'Connected to your Mac.' : state === 'offline' ? 'Mac unreachable. Keep Tailscale on and try Sync when your Mac is awake.' : state === 'reconnect' ? 'Pair again to resume sync.' : state === 'syncing' ? 'Syncing…' : connectionMessage}</p><p>{offlineReady ? 'Offline reading is ready.' : 'Preparing offline reading…'}{snapshot.lastSync ? ` Last sync: ${new Date(snapshot.lastSync).toLocaleString()}.` : ''}</p></div>}{connection}{shortcutDownloads && <div className="pwa-shortcuts"><a className="library-panel-row" href="/shortcuts/Save%20to%20Cliptext.shortcut"><Icon name="share" size={17} />Save to Cliptext<Icon name="download" size={15} /></a><a className="library-panel-row" href="/shortcuts/Sync%20Cliptext.shortcut"><Icon name="restore" size={17} />Sync Cliptext<Icon name="download" size={15} /></a></div>}<details className="pwa-install-help"><summary>Install on iPhone</summary><p>Open in Safari → Share → Add to Home Screen. Open Cliptext from your Home Screen, then pair there if asked.</p><p>Sync runs while Cliptext is open. Keep Tailscale connected.</p></details>{snapshot.libraryId && <button type="button" className="text-button danger-button" onClick={() => void forget()}>Disconnect and remove phone copy</button>}</>}
    </div>}
  </div>;
}
