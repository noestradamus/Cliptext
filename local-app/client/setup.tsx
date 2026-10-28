import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
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

type PhoneConfiguration = {
  enabled: boolean;
  port: number;
  address: string | null;
  endpoints: string[];
  fingerprint: string | null;
  devices: { id: string; name: string; lastSeen: string | null }[];
  error?: string;
};
type PhoneAction = 'enable' | 'disable' | 'pair' | 'revoke' | 'address';
type PairingCode = { code: string; expiresAt: string; deadline: number; deviceIds: string[] };

function phoneConfiguration(value: Record<string, unknown>): PhoneConfiguration {
  if (typeof value.enabled !== 'boolean' || typeof value.port !== 'number' ||
      !Array.isArray(value.endpoints) || !value.endpoints.every(endpoint => typeof endpoint === 'string') ||
      !Array.isArray(value.devices) || !value.devices.every(device => device && typeof device === 'object' &&
        typeof device.id === 'string' && typeof device.name === 'string' && (device.lastSeen === null || typeof device.lastSeen === 'string'))) {
    throw new Error('Phone connection could not be loaded. Try again.');
  }
  return {
    enabled: value.enabled, port: value.port, address: typeof value.address === 'string' ? value.address : null, endpoints: value.endpoints,
    fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : null,
    devices: value.devices,
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
  };
}

async function phoneRequest(signal: AbortSignal, action?: PhoneAction, fields?: { deviceId?: string; address?: string }) {
  const response = await fetch('/api/local/phone', {
    method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) } : {}),
  });
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error('Phone connection could not be loaded. Try again.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Phone connection could not be loaded. Try again.');
  const value = result as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Phone connection could not be updated. Try again.');
  return { config: phoneConfiguration(value), value };
}

function PhoneConnection() {
  const [phone, setPhone] = useState<PhoneConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<PhoneAction | null>(null);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [addressDraft, setAddressDraft] = useState('');
  const [addressDirty, setAddressDirty] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const codeField = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async (showLoading = false) => {
    if (pending.current) return;
    const controller = new AbortController();
    const current = revision.current;
    requests.current.add(controller);
    if (showLoading) setLoading(true);
    try {
      const result = await phoneRequest(controller.signal);
      if (!mounted.current || current !== revision.current) return;
      setPhone(result.config);
      setError('');
      setPairing(previous => result.config.enabled ? previous : null);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && current === revision.current) {
        setError(failure instanceof Error ? failure.message : 'Phone connection could not be loaded. Try again.');
      }
    } finally {
      requests.current.delete(controller);
      if (mounted.current && current === revision.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const timer = setInterval(() => void refresh(), 10_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [refresh]);

  useEffect(() => {
    if (!addressDirty) setAddressDraft(phone?.address ?? '');
  }, [phone?.address, addressDirty]);

  useEffect(() => {
    if (pairing && phone?.devices.some(device => !pairing.deviceIds.includes(device.id))) {
      setPairing(null);
      setAnnouncement('Phone connected.');
    }
  }, [pairing, phone]);

  useEffect(() => {
    setCodeExpanded(false);
    setCopied(false);
    if (!pairing) { setRemaining(0); return; }
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((pairing.deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) { setPairing(null); setAnnouncement('Pairing code expired.'); }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const qr = useMemo(() => {
    if (!pairing) return null;
    try {
      const image = qrcode(0, 'M');
      image.addData(`cliptextshare://connect?code=${encodeURIComponent(pairing.code)}`);
      image.make();
      const count = image.getModuleCount();
      let path = '';
      for (let row = 0; row < count; row++) {
        for (let column = 0; column < count; column++) {
          if (image.isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
        }
      }
      return { path, size: count + 8 };
    } catch { return null; }
  }, [pairing]);

  async function act(action: PhoneAction, deviceId?: string, address?: string) {
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    const controller = new AbortController();
    requests.current.add(controller);
    setBusy(action);
    setError('');
    setAnnouncement('');
    if (action === 'pair' || action === 'disable' || action === 'address') setPairing(null);
    try {
      const { config, value } = await phoneRequest(controller.signal, action, action === 'address' ? { address: address ?? '' } : deviceId ? { deviceId } : undefined);
      if (!mounted.current) return;
      if (action === 'pair') {
        const deadline = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
        if (typeof value.code !== 'string' || !value.code || !Number.isFinite(deadline) || deadline <= Date.now()) {
          throw new Error('A pairing code could not be created. Try again.');
        }
        const boundedDeadline = Math.min(deadline, Date.now() + 600_000);
        setRemaining(Math.ceil((boundedDeadline - Date.now()) / 1000));
        setPairing({ code: value.code, expiresAt: String(value.expiresAt), deadline: boundedDeadline, deviceIds: config.devices.map(device => device.id) });
      }
      setPhone(config);
      if (action === 'revoke') setAnnouncement('Phone disconnected.');
      if (action === 'address') { setAddressDirty(false); setAnnouncement(config.address ? 'Address saved.' : 'Using detected addresses.'); }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Phone connection could not be updated. Try again.');
    } finally {
      requests.current.delete(controller);
      pending.current = false;
      if (mounted.current) { setBusy(null); setLoading(false); }
    }
  }

  async function copyCode() {
    if (!pairing || pairing.deadline <= Date.now()) { setPairing(null); return; }
    try {
      await navigator.clipboard.writeText(pairing.code);
      if (mounted.current) { setCopied(true); setAnnouncement('Pairing code copied.'); }
    } catch {
      if (!mounted.current) return;
      setCodeExpanded(true);
      setAnnouncement('Select and copy the pairing code.');
      requestAnimationFrame(() => { codeField.current?.focus(); codeField.current?.select(); });
    }
  }

  const connectionError = error || phone?.error;
  const available = phone?.enabled && !phone.error && phone.endpoints.length > 0;
  const status = loading && !phone ? 'Checking…' : connectionError ? 'Unavailable' : phone?.enabled ? 'Enabled' : 'Off';
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  return <section className="setup-card local-phone-card" aria-labelledby="local-phone-title">
    <div className="local-setup-heading"><h2 id="local-phone-title">Phone sharing</h2><span className={`engine-state ${phone ? phone.enabled && !connectionError ? 'is-online' : 'is-offline' : ''}`} role="status"><span className="status-dot" />{status}</span></div>
    <p className="setup-note local-phone-note">Syncs when your Mac is reachable.</p>
    {connectionError && <p className="field-error" role="alert">{connectionError}</p>}
    {!phone && !loading && <button className="text-button" type="button" onClick={() => void refresh(true)}>Try again</button>}
    {phone && <div className="local-phone-actions">
      {phone.enabled ? <><button type="button" className="button-secondary" onClick={() => void act('pair')} disabled={!!busy || !available}>{busy === 'pair' ? 'Creating…' : pairing ? 'New pairing code' : 'Pair phone'}</button><button type="button" className="text-button" aria-label="Disable phone connection" onClick={() => void act('disable')} disabled={!!busy}>{busy === 'disable' ? 'Turning off…' : 'Turn off'}</button></> : <button type="button" className="button-secondary" onClick={() => void act('enable')} disabled={!!busy}>{busy === 'enable' ? 'Enabling…' : 'Enable phone connection'}</button>}
    </div>}
    {phone?.enabled && !phone.error && phone.endpoints.length === 0 && <p className="setup-note">Connect your Mac to a network to pair a phone.</p>}
    {pairing && <div className="local-phone-pairing">
      {qr ? <svg className="local-phone-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} width="208" height="208" role="img" aria-label="Scan to connect Cliptext Share" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="#ffffff" /><path d={qr.path} fill="#000000" /></svg> : <p className="setup-note">Copy the pairing code to connect.</p>}
      {qr && <p className="setup-note local-phone-scan">Scan with your phone camera.</p>}
      <div className="local-phone-code-actions"><button type="button" className="button-secondary" onClick={() => void copyCode()}><CliptextIcon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copied' : 'Copy code'}</button><time className="setup-note" dateTime={pairing.expiresAt}>Expires in {countdown}</time></div>
      <details className="local-phone-code-details" open={codeExpanded} onToggle={event => setCodeExpanded(event.currentTarget.open)}><summary>Pairing code</summary><label className="screen-reader-status" htmlFor="local-phone-code">Pairing code for Cliptext Share</label><textarea ref={codeField} id="local-phone-code" className="local-phone-code" value={pairing.code} readOnly spellCheck={false} autoComplete="off" rows={4} onFocus={event => event.currentTarget.select()} /><p className="setup-note">Paste into Cliptext Share → Connection.</p></details>
    </div>}
    {!!phone?.devices.length && <ul className="local-phone-devices" aria-label="Paired phones">{phone.devices.map(device => <li key={device.id}><div><strong>{device.name || 'Android phone'}</strong><span>{device.lastSeen && Number.isFinite(Date.parse(device.lastSeen)) ? `Last connected ${new Date(device.lastSeen).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not connected yet'}</span></div><button type="button" className="text-button" disabled={!!busy} onClick={() => void act('revoke', device.id)} aria-label={`Disconnect ${device.name || 'Android phone'}`}>Disconnect</button></li>)}</ul>}
    {phone && <details className="local-phone-details"><summary>Network</summary>
      <p className="setup-note">For access away from home, use Tailscale on both devices. <a href="https://tailscale.com/download/mac" target="_blank" rel="noreferrer">Install for Mac</a></p>
      <form className="local-phone-address-form" onSubmit={event => { event.preventDefault(); void act('address', undefined, addressDraft.trim()); }}>
        <label htmlFor="local-phone-address">Custom Mac address</label>
        <div><input id="local-phone-address" type="url" value={addressDraft} placeholder={`https://your-mac.tailnet.ts.net:${phone.port}`} maxLength={300} disabled={!!busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => { setAddressDraft(event.target.value); setAddressDirty(true); }} /><button type="submit" className="text-button" disabled={!!busy || !addressDirty}>{busy === 'address' ? 'Saving…' : 'Save'}</button></div>
      </form>
      {(phone.endpoints.length > 0 || phone.fingerprint) && <dl>{phone.endpoints.map(endpoint => <div key={endpoint}><dt>Address</dt><dd>{endpoint}</dd></div>)}{phone.fingerprint && <div><dt>Certificate</dt><dd>{phone.fingerprint}</dd></div>}</dl>}
    </details>}
    <p className="screen-reader-status" role="status">{announcement}</p>
  </section>;
}

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
      <PhoneConnection />
    </div>
  </main>;
}
