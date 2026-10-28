"use client";

import { useState } from 'react';
import type { FullJob, JobChanges, LibraryData } from './library-controls';
import { shortSummary } from '../lib/library-upgrade';
import { visibleSuggestedTags } from '../lib/suggestions';

function safeResourceUrl(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export default function JobInsights({ job, collections, saving, onSave, mode = 'summary' }: {
  job: FullJob; collections: LibraryData['collections']; saving: boolean; onSave: (changes: JobChanges) => Promise<boolean>;
  mode?: 'summary' | 'organization' | 'details';
}) {
  const [takeawaysVisible, setTakeawaysVisible] = useState(false);
  const insights = job.insights;
  const summary = shortSummary(insights?.summary ?? '');
  const suggestions = job.suggestions;
  const collection = suggestions?.collectionId ? collections.find(item => item.id === suggestions.collectionId) : null;
  const newTags = visibleSuggestedTags(suggestions?.tags, job.tags);
  const hasSuggestions = !!(collection && collection.id !== job.collectionId) || newTags.length > 0;
  if (mode === 'organization') {
    if (!hasSuggestions || job.trashedAt) return null;
    return <div className="organization-suggestions"><span>Suggested</span><div className="suggested-tags">{collection && collection.id !== job.collectionId && <span className="suggested-collection">{collection.name}</span>}{newTags.map(tag => <span className="tag" key={tag}>{tag}</span>)}</div><button type="button" className="text-button" disabled={saving} onClick={() => void onSave({ acceptSuggestions: true })}>Apply</button></div>;
  }
  if (mode === 'details') {
    if (!insights) return null;
    return <div className="insight-details">
      {insights.takeaways.length > 0 && <><button type="button" className={`timestamp-toggle ${takeawaysVisible ? 'is-active' : ''}`} role="switch" aria-checked={takeawaysVisible} aria-controls="key-takeaways" onClick={() => setTakeawaysVisible(current => !current)}><span className="switch-track"><span /></span>Key takeaways</button><ul id="key-takeaways" className="takeaways insight-takeaway-list" aria-label="Key takeaways" hidden={!takeawaysVisible}>{insights.takeaways.map((takeaway, index) => <li key={index}>{takeaway}</li>)}</ul></>}
      {insights.resources.length > 0 && <section className="insight-resources" aria-label="Resources mentioned"><h3>Resources mentioned</h3><ul>{insights.resources.map((resource, index) => { const url = safeResourceUrl(resource.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noreferrer">{resource.label}</a> : resource.label}</li>; })}</ul></section>}
    </div>;
  }
  return <section className="job-insights" aria-label="Summary">
    <div className="insights-heading"><h3>Summary</h3></div>
    {(job.insightStatus === 'queued' || job.insightStatus === 'processing') && <p className="insight-status" role="status">{job.insightStatus === 'processing' ? 'Preparing on your Mac…' : 'Queued for your Mac'}</p>}
    {insights && <p className="summary-text" title={summary}>{summary}</p>}
    {job.insightStatus === 'failed' && <p className="field-error" role="alert">{job.insightError || 'The summary couldn’t be prepared.'}</p>}
  </section>;
}
