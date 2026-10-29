import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { THEME_BOOTSTRAP_SCRIPT } from '../../lib/theme-appearance';

const pwaRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(pwaRoot);
const projectRoot = path.dirname(appRoot);

export default defineConfig({
  root: pwaRoot, publicDir: path.join(projectRoot, 'public'),
  plugins: [react(), {
    name: 'cliptext-offline-phone-shell',
    transformIndexHtml() { return [{ tag: 'script', attrs: { src: '/theme-bootstrap.js' }, injectTo: 'head-prepend' }]; },
    async generateBundle(_options, bundle) {
      const emit = (fileName: string, source: string | Uint8Array) => this.emitFile({ type: 'asset', fileName, source });
      emit('theme-bootstrap.js', THEME_BOOTSTRAP_SCRIPT);
      for (const name of ['favicon.svg', 'icon-192.png', 'icon-512.png']) emit(name, await readFile(path.join(projectRoot, 'public', name)));
      // Use existing self-hosted fonts; installation never depends on a CDN.
      for (const name of await readdir(path.join(projectRoot, 'public/fonts'))) {
        if (/\.(?:woff2?|ttf|css|txt)$/i.test(name)) emit(`fonts/${name}`, await readFile(path.join(projectRoot, 'public/fonts', name)));
      }
      // Only these generic, signed files are distributable. Pairing credentials
      // are entered by each user and never embedded into the download.
      try {
        for (const name of ['Save to Cliptext.shortcut', 'Sync Cliptext.shortcut']) emit(`shortcuts/${name}`, await readFile(path.join(projectRoot, 'ios-shortcuts/dist', name)));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      emit('manifest.webmanifest', JSON.stringify({ id: '/', name: 'Cliptext', short_name: 'Cliptext', start_url: '/', scope: '/', display: 'standalone', background_color: '#FFFFFF', theme_color: '#FFFFFF', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }));
    },
    // writeBundle sees the final HTML, hashed imports, and emitted fonts. A failed
    // precache does not activate a shell that would silently break offline.
    async writeBundle(options) {
      const { writeFile } = await import('node:fs/promises');
      const directory = String(options.dir);
      async function files(dir: string, prefix = ''): Promise<string[]> {
        const output: string[] = [];
        for (const item of await readdir(dir, { withFileTypes: true })) {
          if (item.isDirectory()) { if (item.name !== 'shortcuts') output.push(...await files(path.join(dir, item.name), prefix + item.name + '/')); }
          else if (item.name !== 'sw.js' && !item.name.endsWith('.shortcut')) output.push(prefix + item.name);
        }
        return output;
      }
      const names = (await files(directory)).sort();
      const hash = createHash('sha256');
      for (const name of names) { hash.update(name); hash.update(await readFile(path.join(directory, name))); }
      const assets = names.map(name => '/' + name);
      const version = hash.digest('hex').slice(0, 20);
      const source = `const SHELL='cliptext-pwa-shell-${version}';\nconst ASSETS=${JSON.stringify(assets)};\nconst ALLOWED=new Set(ASSETS);\nself.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));\nself.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('cliptext-pwa-shell-')&&name!==SHELL).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));\nself.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;if(request.mode==='navigate'&&(url.pathname==='/'||url.pathname==='/index.html')){event.respondWith(caches.open(SHELL).then(cache=>cache.match('/index.html')).then(cached=>cached||fetch(request)));return;}if(ALLOWED.has(url.pathname))event.respondWith(caches.open(SHELL).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(request)));});\n`;
      await writeFile(path.join(directory, 'sw.js'), source);
    },
  }],
  resolve: { alias: { '@': projectRoot } },
  build: { outDir: path.join(appRoot, 'dist/pwa'), emptyOutDir: true, sourcemap: false, copyPublicDir: false },
});
