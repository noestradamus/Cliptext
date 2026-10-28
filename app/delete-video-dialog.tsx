"use client";

import { useEffect, useRef } from 'react';
import { CliptextIcon, jobLabel } from './library-controls';
import type { FullJob } from './library-controls';

export default function DeleteVideoDialog({ job, deleting, error, onCancel, onDelete }: {
  job: FullJob | null;
  deleting: boolean;
  error: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (job && !dialog.open) { dialog.showModal(); cancelRef.current?.focus(); }
    if (!job && dialog.open) dialog.close();
  }, [job?.id]);

  return <dialog ref={dialogRef} className="delete-video-dialog" aria-labelledby="delete-video-heading" aria-describedby="delete-video-description" onCancel={(event) => { event.preventDefault(); if (!deleting) onCancel(); }}>
    {job && <>
      <h2 id="delete-video-heading">{job.trashedAt ? 'Delete permanently?' : 'Move to Trash?'}</h2>
      <p className="delete-video-name">{jobLabel(job)}</p>
      <p id="delete-video-description">{job.trashedAt ? 'This removes the item, transcript, notes, and images permanently.' : 'You can restore this item from Trash.'}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="delete-video-actions">
        <button ref={cancelRef} type="button" className="button-secondary" disabled={deleting} onClick={onCancel}>Cancel</button>
        <button type="button" className="button-primary delete-confirm" disabled={deleting} onClick={onDelete}>{deleting ? <span className="spinner" aria-hidden="true" /> : <CliptextIcon name="trash" size={16} />}{deleting ? 'Removing…' : job.trashedAt ? 'Delete permanently' : 'Move to Trash'}</button>
      </div>
    </>}
  </dialog>;
}
