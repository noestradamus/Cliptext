import { createRoot } from 'react-dom/client';
import '../../app/globals.css';
import './pwa.css';
import PhoneApp from './app';
import PhoneThemeProvider from './theme';

// Pairing secrets belong in fragments only and disappear before React, storage,
// service-worker registration or any request can run.
const fragment = new URLSearchParams(location.hash.slice(1));
const pairingCode = fragment.get('pair') ?? '';
if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
const root = document.getElementById('root');
if (!root) throw new Error('Cliptext could not open.');
createRoot(root).render(<PhoneThemeProvider><PhoneApp pairingCode={pairingCode} /></PhoneThemeProvider>);
