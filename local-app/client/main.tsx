import { createRoot } from 'react-dom/client';
import CliptextApp from '../../app/cliptext-app';
import ThemeProvider from '../../app/theme-provider';
import '../../app/globals.css';
import './setup.css';
import LocalSetup from './setup';

const mount = document.getElementById('root');
if (!mount) throw new Error('The Cliptext window could not be opened.');

const root = createRoot(mount);

async function openLocalLibrary() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('connect');
  try {
    const response = await fetch('/api/local/session', {
      method: token ? 'POST' : 'GET',
      credentials: 'same-origin', cache: 'no-store',
      ...(token ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) } : {}),
    });
    if (!response.ok) throw new Error('The local library is not connected.');
    const setup = /^\/setup\/?$/.test(window.location.pathname);
    root.render(<ThemeProvider>{setup ? <LocalSetup /> : <CliptextApp />}</ThemeProvider>);
  } catch {
    root.render(<main className="setup-page"><h1>Cliptext</h1><p role="alert">Open Cliptext from the Mac app.</p></main>);
  } finally {
    if (token) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }
}

void openLocalLibrary();
