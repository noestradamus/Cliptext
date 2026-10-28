"use client";

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CliptextIcon } from './library-controls';

export default function ReaderControls({ organization, tools, actions }: {
  organization?: ReactNode; tools: ReactNode; actions: ReactNode;
}) {
  const [panel, setPanel] = useState<'organization' | 'tools' | null>(null);
  const organizationButton = useRef<HTMLButtonElement>(null);
  const toolsButton = useRef<HTMLButtonElement>(null);
  function close() {
    (panel === 'organization' ? organizationButton : toolsButton).current?.focus({ preventScroll: true });
    setPanel(null);
  }
  return <div className="reader-controls" onKeyDown={event => {
    if (event.key === 'Escape' && panel && !event.defaultPrevented) { event.preventDefault(); close(); }
  }}>
    <div className="reader-control-row">
      {organization && <button ref={organizationButton} type="button" className="reader-tool-toggle" aria-expanded={panel === 'organization'} aria-controls="reader-organization" title="Tags and collection" onClick={() => setPanel(current => current === 'organization' ? null : 'organization')}>Organize<CliptextIcon name="chevronDown" size={14} /></button>}
      <button ref={toolsButton} type="button" className="reader-tool-toggle" aria-expanded={panel === 'tools'} aria-controls="reader-tools" onClick={() => setPanel(current => current === 'tools' ? null : 'tools')}>Options<CliptextIcon name="chevronDown" size={14} /></button>
      <div className="reader-primary-actions">{actions}</div>
    </div>
    {organization && <div id="reader-organization" className="reader-panel" hidden={panel !== 'organization'}>{organization}</div>}
    <div id="reader-tools" className="reader-panel" hidden={panel !== 'tools'}>{tools}</div>
  </div>;
}
