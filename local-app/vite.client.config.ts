import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { THEME_BOOTSTRAP_SCRIPT } from '../lib/theme-appearance';

const localRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(localRoot);

export default defineConfig({
  root: localRoot,
  publicDir: path.join(projectRoot, 'public'),
  plugins: [
    react(),
    {
      name: 'cliptext-local-theme-bootstrap',
      transformIndexHtml() {
        return [{ tag: 'script', attrs: { src: '/theme-bootstrap.js' }, injectTo: 'head-prepend' }];
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'theme-bootstrap.js', source: THEME_BOOTSTRAP_SCRIPT });
      },
      configureServer(server) {
        server.middlewares.use('/theme-bootstrap.js', (_request, response) => {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.end(THEME_BOOTSTRAP_SCRIPT);
        });
      },
    },
  ],
  resolve: { alias: { '@': projectRoot } },
  build: {
    outDir: path.join(localRoot, 'dist', 'client'),
    emptyOutDir: true,
    sourcemap: false,
  },
});
