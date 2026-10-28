import { build as buildServer } from 'esbuild';
import { build as buildClient } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const app = dirname(fileURLToPath(import.meta.url));
const root = dirname(app);
await buildClient({ configFile: resolve(app, 'vite.client.config.ts') });
await mkdir(resolve(app, 'dist/server'), { recursive: true });
const result = await buildServer({
  entryPoints: [resolve(app, 'server/main.ts')], outfile: resolve(app, 'dist/server/main.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false,
  metafile: true, legalComments: 'linked',
  banner: { js: "import { createRequire as cliptextCreateRequire } from 'node:module'; const require = cliptextCreateRequire(import.meta.url);" },
  plugins: [{ name: 'cliptext-local-bindings', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve(app, 'server/bindings.ts') }));
    builder.onResolve({ filter: /(?:^|\/)app\/chatgpt-auth(?:\.ts)?$/ }, () => ({ path: resolve(app, 'server/auth.ts') }));
  } }],
});
await cp(resolve(root, 'drizzle'), resolve(app, 'dist/migrations'), { recursive: true });
await writeFile(resolve(app, 'dist/server/build-inputs.json'), JSON.stringify(result.metafile, null, 2));
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some(path => /(?:sites-vite-plugin|app\/chatgpt-auth|sites-env|cloudflare\/vite)/.test(path))) throw new Error('The local server still includes a hosted runtime dependency.');
console.log(JSON.stringify({ localBuild: true, client: resolve(app, 'dist/client'), server: resolve(app, 'dist/server/main.mjs'), serverInputs: inputs.length }));
