import type { LibrarySnapshot } from './types';
import { PhoneStorage } from './storage';

export type ConnectionState = 'syncing' | 'synced' | 'offline' | 'reconnect' | 'error';
export type Session = { connected: true; libraryId: string; deviceId: string; csrfToken: string; shortcutDownloads?: boolean };
export class PhoneRequestError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) { super(message); }
}
export type PhoneStore = Pick<PhoneStorage, 'snapshot' | 'connect' | 'applyPage' | 'resetHistory' | 'acknowledge' | 'markError' | 'forget' | 'isDisconnected'>;
export type SyncEvents = { changed: (snapshot: LibrarySnapshot) => void; state: (state: ConnectionState, message?: string) => void; session?: (session: Session) => void };

export class PhoneSyncClient {
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private pairing = false;
  constructor(private storage: PhoneStore, private events: SyncEvents, private request: typeof fetch = fetch.bind(globalThis)) {}
  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await this.request(`/api/pwa/${path}`, { ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Mac sent an unexpected response. Try Sync again.');
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new PhoneRequestError(typeof body.error === 'string' ? body.error : 'Sync could not finish. Try again.', response.status, body);
      return body as T;
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
  private async session(): Promise<Session> {
    const value = await this.api<Session>('session');
    if (value.connected !== true || typeof value.libraryId !== 'string' || typeof value.csrfToken !== 'string') throw new Error('Connect to your Mac again.');
    this.events.session?.(value);
    return value;
  }
  async pair(code: string, name = 'iPhone'): Promise<void> {
    this.cancel();
    const generation = this.generation;
    this.pairing = true;
    try {
      const session = await this.api<Session>('pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
      if (generation !== this.generation) return;
      this.events.session?.(session);
      await this.storage.connect(session.libraryId);
      if (generation !== this.generation) return;
      this.events.changed(await this.storage.snapshot());
    } finally { if (generation === this.generation) this.pairing = false; }
    if (generation === this.generation) await this.sync();
  }
  sync(): Promise<void> {
    if (this.pairing) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    const operation = this.perform(generation).finally(() => { if (this.pending === operation) this.pending = null; });
    this.pending = operation;
    return operation;
  }
  private async perform(generation: number): Promise<void> {
    const current = () => this.generation === generation;
    this.events.state('syncing');
    try {
      if (await this.storage.isDisconnected()) { if (current()) this.events.state('reconnect'); return; }
      const session = await this.session();
      if (!current()) return;
      let snapshot = await this.storage.snapshot();
      if (snapshot.libraryId && snapshot.libraryId !== session.libraryId) {
        this.events.state('reconnect', 'This Mac has a different library. Pair again to replace the phone copy.'); return;
      }
      if (!snapshot.libraryId) { await this.storage.connect(session.libraryId); snapshot = await this.storage.snapshot(); }
      const libraryId = session.libraryId;
      const headers = { 'Content-Type': 'application/json', 'X-Cliptext-CSRF': session.csrfToken };
      for (const link of snapshot.outbox) {
        if (!current()) return;
        if (link.error) continue;
        try {
          const receipt = await this.api<{ jobId: string }>('links', { method: 'POST', headers, body: JSON.stringify({ requestId: link.requestId, url: link.url }) });
          if (!current()) return;
          if (typeof receipt.jobId !== 'string' || !receipt.jobId) throw new Error('The Mac did not confirm this link. It remains queued.');
          await this.storage.acknowledge(libraryId, link.requestId);
          this.events.changed(await this.storage.snapshot());
        } catch (error) {
          if (error instanceof PhoneRequestError && [400, 409, 413, 415, 422].includes(error.status)) { await this.storage.markError(libraryId, link.requestId, error.message); continue; }
          // A full Mac queue must not prevent downloading completed transcripts.
          if (error instanceof PhoneRequestError && error.status === 429) break;
          throw error;
        }
      }
      let reset = false;
      for (let pages = 0; pages < 10_000; pages++) {
        if (!current()) return;
        snapshot = await this.storage.snapshot();
        let page: unknown;
        try { page = await this.api(`sync?cursor=${snapshot.cursor}&limit=50`); }
        catch (error) {
          if (!reset && error instanceof PhoneRequestError && error.status === 409 && error.body.resetRequired === true) {
            await this.storage.resetHistory(libraryId); reset = true; continue;
          }
          throw error;
        }
        if (!current()) return;
        const received = page as { libraryId?: string; hasMore: boolean };
        if (received.libraryId !== libraryId) throw new Error('The Mac library changed during sync. Pair again.');
        await this.storage.applyPage(libraryId, snapshot.cursor, page);
        this.events.changed(await this.storage.snapshot());
        if (!received.hasMore) { this.events.state('synced'); return; }
      }
      throw new Error('The library is still syncing. Tap Sync to continue.');
    } catch (error) {
      if (!current()) return;
      if (error instanceof PhoneRequestError) {
        this.events.state(error.status === 401 || error.status === 403 ? 'reconnect' : error.status === 503 ? 'offline' : 'error', error.message);
      } else if (error instanceof TypeError || error instanceof DOMException && error.name === 'AbortError') {
        this.events.state('offline');
      } else this.events.state('error', error instanceof Error ? error.message : 'Sync could not finish. Try again.');
    }
  }
  cancel() { ++this.generation; this.controller?.abort(); this.pending = null; this.pairing = false; }
  async forget(): Promise<void> {
    this.cancel();
    // Clear private reading data first, even if the Mac is unreachable. A
    // persistent local marker prevents an old HttpOnly cookie from silently
    // restoring the copy on the next foreground sync.
    await this.storage.forget();
    this.events.changed(await this.storage.snapshot()); this.events.state('reconnect');
    try {
      const session = await this.session();
      await this.api('disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cliptext-CSRF': session.csrfToken }, body: '{}' });
    } catch { /* The Mac can revoke this browser separately in Sharing setup. */ }
  }
}
