import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const project = dirname(here);
function value(flag) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; }
const output = resolve(value('--output') ?? join(project, '.engine-build', 'CliptextLocal'));
const previous = value('--engine-bundle');
const models = value('--models');
if (!previous || !models) throw new Error('Supply the verified --engine-bundle and --models directories.');
await mkdir(output, { recursive: false, mode: 0o700 });
function clone(from, to) {
  const result = spawnSync('/bin/cp', ['-cR', resolve(from), to], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The local package could not be copied.');
}
clone(previous, join(output, 'engine'));
clone(models, join(output, 'models'));
for (const directory of ['client', 'server', 'migrations']) await cp(join(here, 'dist', directory), join(output, directory), { recursive: true });
await rm(join(output, 'client', 'downloads'), { recursive: true, force: true });
await rm(join(output, 'server', 'build-inputs.json'), { force: true });
const names = ['worker.py', 'local_service.py', 'standalone.py', 'insights.py', 'ocr.py', 'image_posts.py', 'checkpoints.py', 'local_processes.py', 'vision-ocr.swift'];
const sources = {};
for (const name of names) {
  const file = join(project, 'local-worker', name);
  await cp(file, join(output, 'engine', 'engine', name));
  sources[name] = createHash('sha256').update(await readFile(file)).digest('hex');
}
await rm(join(output, 'engine', 'engine', '__pycache__'), { recursive: true, force: true });
const engineManifestPath = join(output, 'engine', 'resources', 'engine-manifest.json');
const engineManifest = JSON.parse(await readFile(engineManifestPath, 'utf8'));
await writeFile(engineManifestPath, JSON.stringify({ ...engineManifest, version: '0.3.0', sourceSha256: sources }, null, 2) + '\n');
const manifest = { format: 'cliptext-local-app', version: '0.3.0', architecture: 'arm64', minimumMacOS: '26.2',
  publicReleaseReady: false, interface: 'existing-react-client', storage: 'local-sqlite-and-files',
  processing: 'packaged-python-mlx-vision', hostedRuntimeRequired: false, phoneSyncIncluded: true, sources };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const launcher = join(output, 'Start Cliptext.command');
await writeFile(launcher, `#!/bin/sh
set -eu
cliptext_app_root="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd -P)"
unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PATH="$cliptext_app_root/engine/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_NO_WARNINGS=1
exec "$cliptext_app_root/engine/bin/node" "$cliptext_app_root/server/main.mjs" --open "$@"
`);
await chmod(launcher, 0o755);
await writeFile(join(output, 'README.txt'), 'Cliptext local prototype\n\nDouble-click Start Cliptext.command. Keep its Terminal window open while using Cliptext.\nThe interface opens in your browser; the library and processing run on this Mac.\nDefault library: ~/Library/Application Support/Cliptext\nStop: press Control-C in its Terminal window.\n\nIn Sharing setup, enable Phone sharing and pair Cliptext Share for Android. The phone queues links until the Mac is reachable and keeps synced transcripts offline. Sync requires the same network or a private VPN such as Tailscale; Android may delay background jobs.\nModels are already prepared in the models folder. No Sites account, Homebrew, installed Python or Node is required to run it.\n\nApple Silicon, macOS26.2+. Local prototype; not notarized/public-distribution ready.\n');
console.log(JSON.stringify({ package: output, hostedRuntimeRequired: false, modelsIncluded: true }));
