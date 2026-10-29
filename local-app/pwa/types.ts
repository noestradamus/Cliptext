import type { FullJob } from '../../app/library-controls';

/** The effective reading copy used by Android and the web companion. */
export type PhoneJob = Omit<FullJob, 'segments' | 'preview' | 'insights'> & {
  insights: { summary: string; takeaways: string[] } | null;
};
export type Collection = { id: string; name: string };
export type SyncChange = { seq: number; id: string; deleted: boolean; job?: PhoneJob };
export type SyncPage = { changes: SyncChange[]; cursor: number; hasMore: boolean; collections: Collection[] };
export type OutboxLink = { requestId: string; url: string; createdAt: number; error?: string };
export type LibrarySnapshot = {
  libraryId: string | null; cursor: number; lastSync: number | null;
  jobs: PhoneJob[]; collections: Collection[]; outbox: OutboxLink[];
};
export const EMPTY_SNAPSHOT: LibrarySnapshot = { libraryId: null, cursor: 0, lastSync: null, jobs: [], collections: [], outbox: [] };
