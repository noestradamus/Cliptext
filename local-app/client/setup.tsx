import { useEffect, useState } from 'react';
import { CliptextIcon } from '../../app/library-controls';

type LocalConfig = {
  dataDir?: string;
  databasePath?: string;
  engineBundle?: string;
  modelsDir?: string;
  engineReady?: boolean;
  speechModelReady?: boolean;
  insightsModelReady?: boolean;
  worker?: { running?: boolean; error?: string | null };
};

type EngineStatus = { online: boolean; worker?: { engine?: string; status?: string } | null };

export default function LocalSetup() {
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const refresh = async () => {
      try {
        const [settings, status] = await Promise.all([
          fetch('/api/local/config', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }),
          fetch('/api/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }),
        ]);
        if (!settings.ok || !status.ok || !settings.headers.get('content-type')?.includes('application/json') || !status.headers.get('content-type')?.includes('application/json')) throw new Error('Local setup could not be loaded.');
        const next = await settings.json() as LocalConfig;
        const engine = await status.json() as EngineStatus;
        if (!active) return;
        setConfig(next);
        setOnline(engine.online);
        setError('');
      } catch (failure) {
        if (active && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Local setup could not be loaded.');
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 10_000);
      }
    };
    void refresh();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, []);

  const configured = [
    ['Library', config?.databasePath || config?.dataDir],
    ['Engine', config?.engineBundle],
    ['Models', config?.modelsDir],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && !!row[1]);

  return <main className="setup-page local-setup-page">
    <header className="setup-header">
      <a className="text-button" href="/"><CliptextIcon name="arrow" size={16} />Back to library</a>
      <h1>Local setup</h1>
    </header>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="setup-grid">
      <section className="setup-card" aria-labelledby="local-engine-title">
        <div className="local-setup-heading"><h2 id="local-engine-title">Engine</h2><span className={`engine-state ${online === null ? '' : online ? 'is-online' : 'is-offline'}`} role="status"><span className="status-dot" />{online === null ? 'Checking…' : online ? 'Running' : 'Stopped'}</span></div>
        <dl className="local-setup-values">
          <div><dt>Transcription</dt><dd>{config?.speechModelReady === false ? 'Model missing' : 'Whisper large-v3'}</dd></div>
          <div><dt>Summaries</dt><dd>{config?.insightsModelReady === false ? 'Model missing' : 'Qwen3 4B'}</dd></div>
          <div><dt>Image text</dt><dd>Apple Vision</dd></div>
        </dl>
        {config?.worker?.error && <p className="field-error" role="alert">{config.worker.error}</p>}
        {configured.length > 0 && <details><summary>Files</summary><dl className="local-setup-paths">{configured.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}
      </section>
      <section className="setup-card" aria-labelledby="local-phone-title">
        <h2 id="local-phone-title">Phone sharing</h2>
        <p className="local-setup-pending">Not connected</p>
        <p className="setup-note">Phone pairing and offline reading are the next milestone.</p>
      </section>
    </div>
  </main>;
}
