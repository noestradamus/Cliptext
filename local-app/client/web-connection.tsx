import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { CliptextIcon } from '../../app/library-controls';

type Device = { id: string; name: string; kind: 'browser' | 'shortcut'; lastSeen: string | null };
type Configuration = { enabled: boolean; origin: string | null; port: number; devices: Device[]; shortcutDownloads?: boolean; error?: string };
type Action = 'enable' | 'disable' | 'origin' | 'pair' | 'shortcut' | 'revoke';
type Pair = { code: string; url: string; expiresAt: string };

async function request(signal: AbortSignal, action?: Action, fields: Record<string, string> = {}) {
  const response = await fetch('/api/local/web', {
    method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'The iPhone connection could not be updated.');
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.devices) ||
      (value.origin !== null && typeof value.origin !== 'string')) throw new Error('The iPhone connection could not be loaded.');
  return value as Configuration & { code?: string; url?: string; expiresAt?: string; shortcut?: Record<string, unknown> };
}

export default function WebConnection() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<Action | 'load' | null>('load');
  const [error, setError] = useState('');
  const [pair, setPair] = useState<Pair | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [message, setMessage] = useState('');
  const [seconds, setSeconds] = useState(0);
  const operations = useRef(new Set<AbortController>());
  const pending = useRef(false);
  const mounted = useRef(true);
  const codeField = useRef<HTMLTextAreaElement>(null);
  const shortcutField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    operations.current.add(controller);
    void request(controller.signal).then(value => {
      if (!mounted.current) return;
      setConfig(value); setAddress(value.origin ?? '');
    }).catch(failure => {
      if (!controller.signal.aborted && mounted.current) setError(failure instanceof Error ? failure.message : 'Connection unavailable.');
    }).finally(() => { operations.current.delete(controller); if (mounted.current) setBusy(null); });
    return () => { mounted.current = false; for (const operation of operations.current) operation.abort(); operations.current.clear(); };
  }, []);

  useEffect(() => {
    if (!pair) { setSeconds(0); return; }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) { setPair(null); setMessage('Pairing code expired.'); }
    };
    tick(); const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [pair]);

  async function act(action: Action, fields: Record<string, string> = {}) {
    if (pending.current) return;
    pending.current = true; setBusy(action); setError(''); setMessage('');
    if (['pair', 'disable', 'origin', 'enable'].includes(action)) setPair(null);
    if (action !== 'pair') setShortcut('');
    const controller = new AbortController(); operations.current.add(controller);
    try {
      const value = await request(controller.signal, action, fields);
      if (!mounted.current) return;
      setConfig(value); setAddress(value.origin ?? '');
      if (value.code && value.url && value.expiresAt) setPair({ code: value.code, url: value.url, expiresAt: value.expiresAt });
      if (value.shortcut) setShortcut(JSON.stringify(value.shortcut));
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(failure instanceof Error ? failure.message : 'Connection unavailable.');
    } finally { operations.current.delete(controller); pending.current = false; if (mounted.current) setBusy(null); }
  }

  async function copy(value: string, isShortcut = false) {
    try { await navigator.clipboard.writeText(value); setMessage('Copied.'); }
    catch { const field = isShortcut ? shortcutField.current : codeField.current; field?.focus(); field?.select(); setMessage('Select and copy the code.'); }
  }

  const qr = useMemo(() => {
    if (!pair) return null;
    const image = qrcode(0, 'M'); image.addData(pair.url); image.make();
    const count = image.getModuleCount(); let path = '';
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (image.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { path, size: count + 8 };
  }, [pair]);

  return <section className="setup-card local-web-card" aria-labelledby="local-web-title">
    <div className="local-setup-heading"><h2 id="local-web-title">iPhone</h2><span className={`engine-state ${config?.enabled && !config.error ? 'is-online' : 'is-offline'}`} role="status"><span className="status-dot" />{busy === 'load' ? 'Checking…' : config?.enabled ? 'Enabled' : 'Off'}</span></div>
    {(error || config?.error) && <p className="field-error" role="alert">{error || config?.error}</p>}
    <form className="local-web-address" onSubmit={event => { event.preventDefault(); void act(config?.enabled ? 'origin' : 'enable', { origin: address.trim() }); }}>
      <label htmlFor="web-origin">Private web address</label>
      <input id="web-origin" type="url" required value={address} placeholder="https://your-mac.tailnet.ts.net" maxLength={300} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={!!busy} onChange={event => setAddress(event.target.value)} />
      <div className="local-phone-actions"><button className="button-secondary" type="submit" disabled={!!busy || !address.trim()}>{busy === 'enable' || busy === 'origin' ? 'Saving…' : config?.enabled ? 'Save address' : 'Enable iPhone connection'}</button>{config?.enabled && <button className="text-button" type="button" disabled={!!busy} onClick={() => void act('disable')}>Turn off</button>}</div>
    </form>
    {config?.enabled && config.origin && <>
      <div className="local-phone-actions"><a className="text-button" href={config.origin} target="_blank" rel="noreferrer">Open Cliptext <CliptextIcon name="arrow" size={16} /></a><button className="button-secondary" type="button" disabled={!!busy || !!config.error} onClick={() => void act('pair')}>{busy === 'pair' ? 'Creating…' : 'Pair iPhone'}</button></div>
      {pair && <div className="local-phone-pairing">
        {qr && <svg className="local-phone-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} width="208" height="208" role="img" aria-label="Scan to connect iPhone" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.path} fill="#000" /></svg>}
        <div className="local-phone-code-actions"><button className="button-secondary" type="button" onClick={() => void copy(pair.code)}><CliptextIcon name="copy" size={16} />Copy code</button><time className="setup-note" dateTime={pair.expiresAt}>Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time></div>
        <details><summary>Pairing code</summary><textarea ref={codeField} className="local-phone-code" aria-label="iPhone pairing code" readOnly value={pair.code} rows={3} onFocus={event => event.currentTarget.select()} /></details>
      </div>}
      <details className="local-web-guide"><summary>Install on iPhone</summary><ol><li>Connect Tailscale on the iPhone.</li><li>Open the private web address in Safari. Choose Share → Add to Home Screen.</li><li>Open Cliptext from the Home Screen, then paste a fresh pairing code.</li><li>Tap Sync. Saved transcripts remain available offline.</li></ol></details>
      <details className="local-web-guide"><summary>Save to Cliptext Shortcut</summary>
        <p className="setup-note">Use the Shortcut from a post’s Share menu. It saves the link before trying your Mac.</p>
        {config.shortcutDownloads && <><p><a className="text-button" href={`${config.origin}/shortcuts/Save%20to%20Cliptext.shortcut`} target="_blank" rel="noreferrer">Download Shortcut <CliptextIcon name="download" size={16} /></a></p><p><a className="text-button" href={`${config.origin}/shortcuts/Sync%20Cliptext.shortcut`} target="_blank" rel="noreferrer">Download Sync Cliptext <CliptextIcon name="download" size={16} /></a></p></>}
        <button className="button-secondary" type="button" disabled={!!busy || !!config.error} onClick={() => void act('shortcut')}>{busy === 'shortcut' ? 'Creating…' : 'Create Shortcut connection'}</button>
        {shortcut && <div className="local-web-shortcut-code"><label htmlFor="shortcut-connection">Connection settings</label><textarea id="shortcut-connection" ref={shortcutField} className="local-phone-code" value={shortcut} rows={4} readOnly onFocus={event => event.currentTarget.select()} /><button className="text-button" type="button" onClick={() => void copy(shortcut, true)}>Copy settings</button><p className="setup-note">Choose the same local parent folder under On My iPhone for both Shortcuts. They create a Cliptext folder inside it. Paste these settings on the first run.</p></div>}
      </details>
    </>}
    {!!config?.devices.length && <ul className="local-phone-devices" aria-label="iPhone connections">{config.devices.map(device => <li key={device.id}><div><strong>{device.name}</strong><span>{device.kind === 'shortcut' ? 'Shortcut' : 'Web app'}</span></div><button className="text-button" type="button" disabled={!!busy} onClick={() => void act('revoke', { deviceId: device.id })} aria-label={`Disconnect ${device.name}`}>Disconnect</button></li>)}</ul>}
    <details className="local-web-guide"><summary>Private HTTPS setup</summary><p className="setup-note">Tailscale Serve must forward this address to <code>http://127.0.0.1:{config?.port ?? 47323}</code>. Keep Cliptext and Tailscale running on the Mac.</p></details>
    <p className="screen-reader-status" role="status">{message}</p>
  </section>;
}
