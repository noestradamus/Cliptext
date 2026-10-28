"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import DeleteVideoDialog from './delete-video-dialog';
import VideoPreview from './video-preview';
import ImagePostText from './image-post-text';
import JobEditor from './job-editor';
import JobNotes from './job-notes';
import JobInsights from './job-insights';
import ReaderControls from './reader-controls';
import { hasFullOcrText, isImagePost, readableTranscript } from '../lib/transcript';
import { extractVideoUrl, platformForUrl } from '../lib/video';
import {
  CliptextIcon as Icon, DEFAULT_FILTERS, JobOrganization, LibrarySidebar, RequestError,
  isAbort, isBusy, jobExtent, jobLabel, jobStatusLabel, platformName, requestJSON as api, timecode, timeLabel,
} from './library-controls';
import type { CollectionChange, FullJob, JobChanges, JobStatus, JobsPage, LibraryData, LibraryFilters } from './library-controls';

type EngineStatus = { online: boolean; worker: { engine: string; status: string; lastSeen: string; activeJobId?: string } | null };

function listingQuery(filters: LibraryFilters) {
  const query = new URLSearchParams({ page: String(filters.page), pageSize: '20', view: filters.view });
  if (filters.q) query.set('q', filters.q);
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.favorite) query.set('favorite', '1');
  if (filters.tag) query.set('tag', filters.tag);
  if (filters.collectionId) query.set('collectionId', filters.collectionId);
  return query.toString();
}

export default function CliptextApp() {
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<LibraryFilters>({ ...DEFAULT_FILTERS });
  const [search, setSearch] = useState('');
  const [listing, setListing] = useState<JobsPage | null>(null);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<FullJob | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FullJob | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [completionAnnouncement, setCompletionAnnouncement] = useState('');
  const [timestamps, setTimestamps] = useState(false);
  const [editing, setEditing] = useState(false);
  const [allOcrText, setAllOcrText] = useState(false);
  const [mobileView, setMobileView] = useState<'transcript' | 'library'>('transcript');
  const [composerOpen, setComposerOpen] = useState(false);

  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerButtonRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const sharedHandled = useRef(false);
  const filtersRef = useRef(filters);
  const selectionRef = useRef<string | null>(null);
  const jobRef = useRef<FullJob | null>(null);
  const metadataSavingRef = useRef(false);
  const previewRetryingRef = useRef(false);
  const editingRef = useRef(false);
  const notesDirtyRef = useRef(false);
  const listingRef = useRef<JobsPage | null>(null);
  const engineRef = useRef<EngineStatus | null>(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const librarySequence = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const libraryController = useRef<AbortController | null>(null);
  const engineController = useRef<AbortController | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousActiveStatus = useRef<{ id: string; status: JobStatus } | null>(null);
  filtersRef.current = filters;
  jobRef.current = selectedJob;
  listingRef.current = listing; engineRef.current = engine;
  const filterKey = listingQuery(filters);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    if (deletingRef.current || (quiet && (selectionRef.current !== id || metadataSavingRef.current || previewRetryingRef.current || editingRef.current || notesDirtyRef.current || detailController.current))) return;
    const sequence = ++detailSequence.current;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    if (!quiet) {
      const changingSelection = selectionRef.current !== null;
      selectionRef.current = id; setSelectedId(id); setDetailLoading(true); setDetailError('');
      editingRef.current = false; setEditing(false); notesDirtyRef.current = false; setMetadataError(''); setTimestamps(false); setAllOcrText(false); if (changingSelection) setActionNote('');
    }
    try {
      const result = await api<{ job: FullJob }>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!mounted.current || sequence !== detailSequence.current || selectionRef.current !== id) return;
      if (result.job.id !== id) { selectionRef.current = result.job.id; setSelectedId(result.job.id); }
      setSelectedJob(result.job); jobRef.current = result.job; setDetailError('');
    } catch (error) {
      if (!isAbort(error) && mounted.current && sequence === detailSequence.current && selectionRef.current === id) setDetailError(error instanceof Error ? error.message : 'This transcript couldn’t be loaded. Try again.');
    } finally {
      if (detailController.current === controller) detailController.current = null;
      if (mounted.current && sequence === detailSequence.current) setDetailLoading(false);
    }
  }, []);

  const refreshList = useCallback(async (quiet = false, requestedFilters?: LibraryFilters) => {
    if (deletingRef.current || (quiet && listController.current)) return;
    const snapshot = { ...(requestedFilters ?? filtersRef.current) };
    const sequence = ++listSequence.current;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    if (!quiet) setListLoading(true);
    try {
      const result = await api<JobsPage>(`/api/jobs?${listingQuery(snapshot)}`, { signal: controller.signal });
      if (!mounted.current || sequence !== listSequence.current) return;
      setListing(result); setListError('');
      if (snapshot.page > Math.max(1, result.totalPages)) setFilters((current) => ({ ...current, page: Math.max(1, result.totalPages) }));
      if (!selectionRef.current && result.jobs[0]) void loadDetail(result.jobs[0].id);
    } catch (error) {
      if (!isAbort(error) && mounted.current && sequence === listSequence.current) setListError(error instanceof Error ? error.message : 'Your library couldn’t be refreshed. Try again.');
    } finally {
      if (listController.current === controller) listController.current = null;
      if (mounted.current && sequence === listSequence.current) setListLoading(false);
    }
  }, [loadDetail]);

  const refreshLibrary = useCallback(async (quiet = false) => {
    if (deletingRef.current || (quiet && libraryController.current)) return;
    const sequence = ++librarySequence.current;
    libraryController.current?.abort();
    const controller = new AbortController(); libraryController.current = controller;
    try {
      const result = await api<LibraryData>('/api/library', { signal: controller.signal });
      if (mounted.current && sequence === librarySequence.current) { setLibrary(result); setLibraryError(''); }
    } catch (error) {
      if (!isAbort(error) && mounted.current && sequence === librarySequence.current) setLibraryError(error instanceof Error ? error.message : 'Collections and tags couldn’t be refreshed.');
    } finally { if (libraryController.current === controller) libraryController.current = null; }
  }, []);

  const refreshEngine = useCallback(async () => {
    if (engineController.current) return;
    const controller = new AbortController(); engineController.current = controller;
    try {
      const result = await api<EngineStatus>('/api/status', { signal: controller.signal });
      if (mounted.current) { setEngine(result); setConnectionError(''); }
    } catch (error) {
      if (!isAbort(error) && mounted.current) setConnectionError(error instanceof Error ? error.message : 'Couldn’t check your local engine. Try reconnecting.');
    } finally { if (engineController.current === controller) engineController.current = null; }
  }, []);

  function announce(message: string) {
    setActionNote(message);
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => setActionNote(''), 4000);
  }

  function chooseView(view: 'transcript' | 'library') {
    setMobileView(view);
    if (window.matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0 });
  }

  const submitLink = useCallback(async (value: string, fromShare = false) => {
    if (!fromShare && (editingRef.current || notesDirtyRef.current) && !window.confirm('Discard your unsaved changes and add these links?')) return;
    const url = extractVideoUrl(value);
    if (!url || !platformForUrl(url)) { setFormError('Paste a TikTok, YouTube, or Instagram post link.'); inputRef.current?.focus(); return; }
    setSubmitting(true); setFormError(''); setActionNote('');
    try {
      const candidates = [...new Set((value.match(/https?:\/\/[^\s<>]+/gi) ?? []).map(link => link.replace(/[),.;]+$/, '')))];
      let job: FullJob;
      let failedLinks: string[] = [];
      if (candidates.length > 1) {
        if (candidates.length > 30) throw new Error('Add up to 30 links at a time.');
        const result = await api<{ results: { url: string; job?: FullJob; error?: string }[] }>('/api/jobs/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: candidates }) });
        const added = result.results.filter(item => item.job);
        const failures = result.results.filter(item => !item.job);
        failedLinks = failures.map(item => item.url);
        if (!added.length) throw new Error(failures[0]?.error || 'These links couldn’t be added.');
        job = added[0].job!;
        announce(`${added.length} links saved.`);
        if (failures.length) setFormError(`${failures.length} links couldn’t be added. ${failures[0].error || 'Check the remaining links.'}`);
      } else {
        const result = await api<{ job: FullJob }>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        job = result.job;
      }
      if (!mounted.current) return;
      ++detailSequence.current; detailController.current?.abort(); detailController.current = null;
      selectionRef.current = job.id; jobRef.current = job;
      setSelectedId(job.id); setSelectedJob(job); setDetailLoading(false); setDetailError(''); setMetadataError('');
      setInput(failedLinks.join('\n')); setComposerOpen(failedLinks.length > 0); editingRef.current = false; setEditing(false); notesDirtyRef.current = false; setTimestamps(false); setAllOcrText(false); setMobileView('transcript'); setSearch(''); setFilters({ ...DEFAULT_FILTERS });
      requestAnimationFrame(() => transcriptRef.current?.scrollTo({ top: 0 }));
      if (fromShare) window.history.replaceState(null, '', '/');
      void refreshList(false, DEFAULT_FILTERS); void refreshLibrary();
    } catch (error) { if (mounted.current) { setComposerOpen(true); setFormError(error instanceof Error ? error.message : 'Couldn’t add this link. Please try again.'); } }
    finally { if (mounted.current) setSubmitting(false); }
  }, [refreshList, refreshLibrary]);

  const updateMetadata = useCallback(async (changes: JobChanges): Promise<boolean> => {
    const id = selectionRef.current;
    if (!id || metadataSavingRef.current || deletingRef.current) return false;
    metadataSavingRef.current = true; setMetadataSaving(true); setMetadataError('');
    const sequence = ++detailSequence.current;
    detailController.current?.abort(); detailController.current = null;
    try {
      const { job } = await api<{ job: FullJob }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      if (!mounted.current) return false;
      if (selectionRef.current === id && sequence === detailSequence.current) { setSelectedJob(job); jobRef.current = job; if ('transcript' in changes || 'pages' in changes) setTimestamps(false); }
      void refreshList(); void refreshLibrary();
      return true;
    } catch (error) {
      if (mounted.current && selectionRef.current === id) {
        setMetadataError(error instanceof Error ? error.message : 'Your changes couldn’t be saved. Try again.');
        if (error instanceof RequestError && error.status === 409) {
          try { const latest = await api<{ job: FullJob }>(`/api/jobs/${encodeURIComponent(id)}`); if (mounted.current && selectionRef.current === id) { setSelectedJob(latest.job); jobRef.current = latest.job; } } catch { /* Keep the draft and original error. */ }
        }
      }
      return false;
    } finally { metadataSavingRef.current = false; if (mounted.current) setMetadataSaving(false); }
  }, [refreshList, refreshLibrary]);

  const retryPreview = useCallback(async (id: string) => {
    if (previewRetryingRef.current || metadataSavingRef.current || deletingRef.current) return;
    previewRetryingRef.current = true;
    ++detailSequence.current; detailController.current?.abort(); detailController.current = null; setDetailLoading(false);
    try {
      const { job } = await api<{ job: FullJob }>(`/api/jobs/${encodeURIComponent(id)}/frame`, { method: 'POST' });
      if (!mounted.current || selectionRef.current !== id) return;
      const preview = { frameStatus: job.frameStatus, frameUrl: job.frameUrl, frameWidth: job.frameWidth, frameHeight: job.frameHeight, frameKind: job.frameKind };
      setSelectedJob((current) => current?.id === id ? { ...current, ...preview } : current);
      if (jobRef.current?.id === id) jobRef.current = { ...jobRef.current, ...preview };
    } finally { previewRetryingRef.current = false; }
  }, []);

  async function deleteVideo() {
    if (!deleteTarget || deletingRef.current || metadataSavingRef.current) return;
    const id = deleteTarget.id;
    deletingRef.current = true; setDeleting(true); setDeleteError('');
    ++detailSequence.current; detailController.current?.abort(); detailController.current = null; setDetailLoading(false);
    ++listSequence.current; listController.current?.abort(); listController.current = null;
    ++librarySequence.current; libraryController.current?.abort(); libraryController.current = null;
    let deleted = false;
    try {
      try { await api(`/api/jobs/${encodeURIComponent(id)}${deleteTarget.trashedAt ? '?permanent=1' : ''}`, { method: 'DELETE' }); }
      catch (error) { if (!(error instanceof RequestError && error.status === 404)) throw error; }
      if (!mounted.current) return;
      deleted = true;
      if (selectionRef.current === id) {
        selectionRef.current = null; jobRef.current = null;
        setSelectedId(null); setSelectedJob(null); setEditing(false); editingRef.current = false; notesDirtyRef.current = false; setDetailLoading(false); setDetailError(''); setMetadataError(''); setTimestamps(false); setAllOcrText(false);
      }
      setListing((current) => current ? { ...current, jobs: current.jobs.filter((job) => job.id !== id) } : current);
      setDeleteTarget(null);
    } catch (error) {
      if (mounted.current) setDeleteError(error instanceof Error ? error.message : 'This item couldn’t be deleted. Try again.');
    } finally { deletingRef.current = false; if (mounted.current) setDeleting(false); }
    if (mounted.current) {
      void refreshList(); void refreshLibrary();
      if (deleted) {
        announce(deleteTarget.trashedAt ? 'Item permanently deleted.' : 'Moved to Trash.');
        requestAnimationFrame(() => transcriptRef.current?.focus({ preventScroll: true }));
      }
    }
  }

  const collectionChanged = useCallback(async (change: CollectionChange) => {
    if (change.type === 'deleted') {
      ++detailSequence.current; detailController.current?.abort(); detailController.current = null; setDetailLoading(false);
      setFilters((current) => current.collectionId === change.id ? { ...current, collectionId: '', page: 1 } : current);
      setSelectedJob((current) => current?.collectionId === change.id ? { ...current, collectionId: null } : current);
    }
    await refreshLibrary(); void refreshList();
  }, [refreshLibrary, refreshList]);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => current.q === search.trim() ? current : { ...current, q: search.trim(), page: 1 }), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { void refreshList(); }, [filterKey, refreshList]);

  useEffect(() => {
    mounted.current = true; void refreshEngine(); void refreshLibrary();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastLibraryRefresh = Date.now();
    const working = () => engineRef.current?.online && (listingRef.current?.jobs.some(job => isBusy(job.status) || job.insightStatus === 'queued' || job.insightStatus === 'processing') || engineRef.current?.worker?.status === 'busy' || isBusy(jobRef.current?.status));
    const refreshVisible = async (immediate = false) => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      const activeWork = working();
      const tasks: Promise<unknown>[] = [refreshList(true), refreshEngine()];
      if (immediate || Date.now() - lastLibraryRefresh >= (activeWork ? 15000 : 60000)) { lastLibraryRefresh = Date.now(); tasks.push(refreshLibrary(true)); }
      const current = jobRef.current;
      if (current && current.id === selectionRef.current && (immediate || isBusy(current.status) || current.insightStatus === 'queued' || current.insightStatus === 'processing' || (current.status === 'completed' && (current.frameStatus === 'pending' || current.frameStatus === 'processing')))) tasks.push(loadDetail(current.id, true));
      await Promise.allSettled(tasks);
      if (mounted.current && document.visibilityState === 'visible') timer = setTimeout(() => void refreshVisible(), working() ? 4000 : 30000);
    };
    const onVisible = () => { if (timer) clearTimeout(timer); if (document.visibilityState === 'visible') void refreshVisible(true); };
    timer = setTimeout(() => void refreshVisible(), 4000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible);
      listController.current?.abort(); detailController.current?.abort(); libraryController.current?.abort(); engineController.current?.abort();
      if (actionTimer.current) clearTimeout(actionTimer.current);
    };
  }, [refreshList, refreshLibrary, refreshEngine, loadDetail]);

  useEffect(() => {
    if (sharedHandled.current) return;
    sharedHandled.current = true;
    const query = new URLSearchParams(window.location.search);
    const requestedJob = query.get('job');
    if (requestedJob && /^[a-zA-Z0-9-]{1,100}$/.test(requestedJob)) { void loadDetail(requestedJob); setMobileView('transcript'); return; }
    const shared = [query.get('url'), query.get('text'), query.get('title')].filter(Boolean).join(' ');
    if (!shared) return;
    const url = extractVideoUrl(shared);
    if (url) { setInput(url); void submitLink(url, true); }
    else { setComposerOpen(true); setInput(shared.slice(0, 4096)); setFormError('The shared text didn’t contain a supported link. Paste a TikTok, YouTube, or Instagram post link.'); }
  }, [submitLink, loadDetail]);

  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }, []);

  const active = selectedJob?.id === selectedId ? selectedJob : null;
  const showComposer = composerOpen || !active;
  const busy = active ? isBusy(active.status) : false;
  const imagePost = isImagePost(active);
  const visibleTranscript = readableTranscript(active, allOcrText);
  const hasVisibleText = imagePost && active?.pages?.length ? active.pages.some(page => (allOcrText ? page.allText ?? page.text : page.text).trim()) : !!visibleTranscript.trim();
  const workerDescription = engine === null ? 'Checking…' : engine.online ? 'Running' : 'Stopped';

  useEffect(() => { if (active?.id) transcriptRef.current?.scrollTo({ top: 0 }); }, [active?.id]);

  useEffect(() => {
    const previous = previousActiveStatus.current;
    if (!active) { previousActiveStatus.current = null; setCompletionAnnouncement(''); return; }
    if (previous?.id === active.id && previous.status !== active.status) {
      if (active.status === 'completed') setCompletionAnnouncement(`Transcript ready for ${jobLabel(active).slice(0, 140)}.`);
      else if (active.status === 'failed') setCompletionAnnouncement('The selected link couldn’t be processed. The error and retry button are available below.');
      else setCompletionAnnouncement('');
    } else if (previous?.id !== active.id) setCompletionAnnouncement('');
    previousActiveStatus.current = { id: active.id, status: active.status };
  }, [active?.id, active?.status, active?.title]);

  async function copyTranscript() {
    if (!active || !hasVisibleText) return;
    try { await navigator.clipboard.writeText(visibleTranscript); announce('Transcript copied.'); }
    catch { announce('Copy isn’t available in this browser. Select the transcript text to copy it.'); }
  }

  function exportTranscript() {
    if (!active || !hasVisibleText) return;
    const title = jobLabel(active);
    const objectUrl = URL.createObjectURL(new Blob([`${title}\n${active.url}\n\n${visibleTranscript}\n`], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = objectUrl;
    anchor.download = `${title.replace(/[^\p{L}\p{N}\s_-]/gu, '').slice(0, 70) || 'transcript'}.txt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); announce('Text file exported.');
  }

  function changeFilters(changes: Partial<LibraryFilters>) { setFilters((current) => ({ ...current, ...changes, page: changes.page ?? 1 })); }
  function resetFilters() { setSearch(''); setFilters({ ...DEFAULT_FILTERS }); }
  function editTranscript(value: boolean) {
    editingRef.current = value; setEditing(value);
    if (value) { setTimestamps(false); setAllOcrText(false); }
    else requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
  }

  function selectVideo(id: string) { if (id !== selectionRef.current && (editingRef.current || notesDirtyRef.current) && !window.confirm('Discard your unsaved changes and open this item?')) return; setMobileView('transcript'); if (id !== selectionRef.current) void loadDetail(id); if (window.matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0 }); }
  function openComposer() { setComposerOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }
  function closeComposer() { setComposerOpen(false); requestAnimationFrame(() => composerButtonRef.current?.focus({ preventScroll: true })); }
  function handleSubmit(event: FormEvent) { event.preventDefault(); if (!submitting) void submitLink(input); }

  return <div className="app-shell" data-mobile-view={mobileView}>
    <a className="skip-link" href={mobileView === 'library' ? '#library-heading' : active && !composerOpen ? '#transcript-result' : '#link-input'}>Skip to {mobileView === 'library' ? 'library' : active && !composerOpen ? 'transcript' : 'post link'}</a>
    <header className="site-header" data-composer-open={showComposer}>
      <a className="wordmark" href="/" aria-label="Cliptext home"><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span><span className="wordmark-label">Cliptext</span></a>
      <form id="link-composer" className="link-form" hidden={!showComposer} onSubmit={handleSubmit} onKeyDown={event => { if (event.key === 'Escape' && active && !submitting) { event.preventDefault(); closeComposer(); } }}><label className="screen-reader-status" htmlFor="link-input">Post or video link</label><div className={`link-field ${formError ? 'has-error' : ''}`}><span className="field-icon"><Icon name="link" /></span><textarea ref={inputRef} id="link-input" rows={1} value={input} maxLength={16000} onChange={(event) => { setInput(event.target.value); if (formError) setFormError(''); }} placeholder="Paste one or more post links…" aria-describedby={formError ? 'form-error' : undefined} aria-invalid={!!formError} autoCapitalize="none" autoCorrect="off" spellCheck={false} /><button className="button-primary" type="submit" aria-label={submitting ? 'Adding…' : 'Extract text'} disabled={!input.trim() || submitting}><span className="composer-submit-label">{submitting ? 'Adding…' : 'Extract text'}</span>{submitting ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrow" size={19} />}</button></div>{formError && <p className="field-error" id="form-error" role="alert">{formError}</p>}</form>
      <div className="header-actions">
        {active && <button ref={composerButtonRef} type="button" className={`button-quiet composer-toggle ${showComposer ? 'is-open' : ''}`} aria-label={showComposer ? 'Close link entry' : 'Add a link'} aria-expanded={showComposer} aria-controls="link-composer" disabled={submitting} onClick={() => showComposer ? closeComposer() : openComposer()}><Icon name={showComposer ? 'close' : 'plus'} size={16} />{!showComposer && 'Add a link'}</button>}
        <span className={`engine-state ${engine === null ? 'is-unknown' : engine.online ? 'is-online' : 'is-offline'}`} title="Speech and image text recognition run on your Mac"><span className="status-dot" />{workerDescription}</span>
      </div>
    </header>
    <nav className="mobile-library-tabs" aria-label="Workspace views"><button type="button" className={mobileView === 'transcript' ? 'is-active' : ''} aria-pressed={mobileView === 'transcript'} onClick={() => chooseView('transcript')}><Icon name="document" size={17} />Transcript</button><button type="button" className={mobileView === 'library' ? 'is-active' : ''} aria-pressed={mobileView === 'library'} onClick={() => chooseView('library')}><Icon name="folder" size={17} />Library{library && <span>{library.stats.total}</span>}</button></nav>
    <main className="app-layout">
      <section className="workspace" aria-label="Extract text from a post">
        <h1 className="screen-reader-status">Transcript</h1>
        <div className="transcript-frame">
        <section id="transcript-result" ref={transcriptRef} tabIndex={-1} className="transcript-sheet" aria-label="Transcript result" aria-busy={detailLoading || busy}>
          {connectionError && <div className="connection-error" role="alert"><p>{connectionError}</p><button type="button" className="text-button" onClick={() => void refreshEngine()}>Try reconnecting</button></div>}
          {detailError && <div className="connection-error" role="alert"><p>{detailError}</p>{selectedId && <button type="button" className="text-button" onClick={() => void loadDetail(selectedId)}>Reload transcript</button>}</div>}
          {detailLoading && !active ? <div className="result-empty"><div className="library-skeleton detail-skeleton" aria-hidden="true"><span /><span /><span /></div><h2>Loading transcript…</h2></div> : !active ? <div className="result-empty"><div className="empty-mark" aria-hidden="true"><span /><span /><span /><span /></div><h2>{listLoading && !listing ? 'Loading…' : 'No transcript selected'}</h2><p>Paste a link or choose an item.</p></div> : <>
            <div className="result-heading">
              {active.status !== 'completed' && <div className="result-heading-top"><div className="result-status"><span className={`job-dot status-${active.status}`} />{jobStatusLabel(active)}</div></div>}
              <div className="result-identity">
                {active.frameStatus === 'ready' && active.frameUrl && <VideoPreview key={active.id} job={active} engineOnline={engine?.online} disabled={metadataSaving || submitting || deleting} onRetry={retryPreview} />}
                <div className="result-title-group"><h2>{jobLabel(active)}</h2><div className="video-meta">{active.creator && <span>{active.platform === 'youtube' || active.creator.startsWith('@') ? active.creator : `@${active.creator}`}</span>}<a href={active.url} target="_blank" rel="noreferrer">Source<Icon name="external" size={13} /></a><span className="platform-badge">{platformName(active.platform)}</span>{jobExtent(active) && <span className="duration">{jobExtent(active)}</span>}{!imagePost && active.language && <span className="language">{active.language.toUpperCase()}</span>}<span>{timeLabel(active.createdAt)}</span></div>
                  {!(active.frameStatus === 'ready' && active.frameUrl) && <VideoPreview key={active.id} job={active} engineOnline={engine?.online} disabled={metadataSaving || submitting || deleting} onRetry={retryPreview} />}
                </div>
              </div>
            </div>

            {active.trashedAt && <p className="trashed-notice">In Trash · Restore to make changes.</p>}
            {metadataError && <p className="field-error detail-field-error" role="alert">{metadataError}</p>}
            {active.status === 'completed' && <JobInsights job={active} collections={library?.collections ?? []} saving={metadataSaving} onSave={updateMetadata} />}
            <ReaderControls key={`reader-${active.id}`} organization={!active.trashedAt ? <>
              <JobOrganization key={active.id} job={active} collections={library?.collections ?? []} saving={metadataSaving} error="" onSave={updateMetadata} onTag={(tag) => { changeFilters({ tag }); chooseView('library'); }} />
              <JobInsights mode="organization" job={active} collections={library?.collections ?? []} saving={metadataSaving} onSave={updateMetadata} />
            </> : undefined} tools={<div className="reader-tool-actions">
              <div className="reader-option-toggles">
                {!active.trashedAt && <button type="button" className={`timestamp-toggle ${active.reviewedAt ? 'is-active' : ''}`} role="switch" aria-checked={!!active.reviewedAt} disabled={metadataSaving || deleting} onClick={() => void updateMetadata({ reviewed: !active.reviewedAt })}><span className="switch-track"><span /></span>Reviewed</button>}
                {active.status === 'completed' && <>
                {imagePost ? hasFullOcrText(active) ? <button type="button" className={`timestamp-toggle ${allOcrText ? 'is-active' : ''}`} role="switch" aria-checked={allOcrText} disabled={editing} onClick={() => setAllOcrText(current => !current)}><span className="switch-track"><span /></span>All detected text</button> : null : <button type="button" className={`timestamp-toggle ${timestamps ? 'is-active' : ''}`} role="switch" aria-checked={timestamps} onClick={() => setTimestamps(current => !current)} disabled={editing || !active.segments?.length || (active.originalTranscript != null && active.originalTranscript !== active.transcript)} title={active.originalTranscript != null && active.originalTranscript !== active.transcript ? 'Timestamps belong to the original transcript' : undefined}><span className="switch-track"><span /></span>Timestamps</button>}
                <JobInsights mode="details" job={active} collections={library?.collections ?? []} saving={metadataSaving} onSave={updateMetadata} />
                </>}
              </div>
              <div className="reader-action-icons">
                {active.trashedAt && <button type="button" className="button-quiet" disabled={metadataSaving || deleting} onClick={async () => { if (await updateMetadata({ restore: true })) { announce('Item restored.'); changeFilters({ view: 'all' }); } }}><Icon name="restore" size={15} />Restore</button>}
                <button type="button" className="reader-icon-action" disabled={metadataSaving || submitting || deleting} aria-label={active.trashedAt ? 'Delete permanently' : imagePost ? 'Move post to Trash' : 'Move video to Trash'} title={active.trashedAt ? 'Delete permanently' : 'Move to Trash'} onClick={() => { setDeleteError(''); setDeleteTarget(active); }}><Icon name="trash" size={18} /></button>
                {active.status === 'completed' && <button type="button" className="reader-icon-action" onClick={exportTranscript} disabled={editing || !hasVisibleText} aria-label="Export transcript as text file" title="Export as .txt"><Icon name="download" size={18} /></button>}
              </div>
            </div>} actions={active.status === 'completed' && <>
              <button ref={editButtonRef} type="button" className="button-quiet" aria-pressed={editing} disabled={editing || metadataSaving || !!active.trashedAt} onClick={() => editTranscript(true)}><Icon name="edit" size={16} />Edit</button>
              <button type="button" className="button-quiet" onClick={copyTranscript} disabled={editing || !hasVisibleText}><Icon name="copy" size={16} />Copy</button>
            </>} />
            {busy && <div className="processing-state" aria-live="polite"><div className="processing-heading"><span className="spinner" aria-hidden="true" /><h3>{active.status === 'queued' ? (engine?.online ? 'Queued' : 'Waiting for your Mac') : active.status === 'downloading' ? 'Retrieving post' : imagePost ? 'Reading images…' : 'Transcribing…'}</h3></div><div className="progress-track" role="progressbar" aria-label="Text extraction progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, active.progress || 0))}><span style={{ width: `${Math.max(4, Math.min(100, active.progress || 0))}%` }} /></div><div className="processing-steps"><span className={active.status !== 'queued' ? 'step-done' : ''}>Queued</span><span className={active.status === 'transcribing' ? 'step-done' : ''}>Retrieve post</span><span>{imagePost ? 'Read images' : 'Extract text'}</span></div></div>}
            {active.status === 'failed' && <div className="failed-state" role="alert"><h3>This link couldn’t be processed.</h3><p>{active.error || 'The post may be restricted, or the local engine couldn’t finish it.'}</p><button type="button" className="button-secondary" disabled={submitting} onClick={() => void submitLink(active.url)}>Try this link again<Icon name="arrow" size={17} /></button></div>}
            {active.status === 'completed' && <>
              <div className={`transcript-content ${!imagePost && timestamps ? 'with-timestamps' : ''}`}>
                {editing ? <JobEditor key={`editor-${active.id}`} job={active} saving={metadataSaving} onSave={updateMetadata} onClose={() => editTranscript(false)} /> : imagePost && active.pages?.length ? <ImagePostText pages={active.pages} carousel={active.contentKind === 'carousel'} allText={allOcrText} /> : timestamps && active.segments?.length ? active.segments.map((segment, index) => <div className="transcript-segment" key={`${segment.start}-${index}`}><span className="timecode">{timecode(segment.start)}</span><p>{segment.text.trim()}</p></div>) : active.transcript ? active.transcript.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className="no-speech">{imagePost ? 'No text detected.' : 'No speech was detected in this video.'}</p>}
              </div>
              <JobNotes key={`notes-${active.id}`} job={active} saving={metadataSaving} onSave={updateMetadata} onDirty={dirty => { notesDirtyRef.current = dirty; }} />
            </>}
          </>}
        </section>
        </div>
        <p className="action-announcement" role="status" aria-live="polite">{actionNote}</p><p className="screen-reader-status" role="status" aria-live="polite" aria-atomic="true">{completionAnnouncement}</p>
      </section>
      <LibrarySidebar listing={listing} library={library} loading={listLoading} error={listError || libraryError} filters={filters} search={search} selectedId={selectedId} onSearch={setSearch} onFilter={changeFilters} onReset={resetFilters} onSelect={selectVideo} onReload={() => { void refreshList(); void refreshLibrary(); if (selectionRef.current) void loadDetail(selectionRef.current, true); }} onCollectionChanged={collectionChanged} />
    </main>
    <DeleteVideoDialog job={deleteTarget} deleting={deleting} error={deleteError} onCancel={() => { if (!deletingRef.current) { setDeleteTarget(null); setDeleteError(''); } }} onDelete={() => void deleteVideo()} />
  </div>;
}
