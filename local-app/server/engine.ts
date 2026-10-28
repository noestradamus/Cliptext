import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type EngineOptions = { bundleDir: string; modelsDir: string; dataDir: string; engineKey: string; origin: string; scriptPath?: string };

export class EngineSupervisor {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  error: string | null = null;
  constructor(readonly options: EngineOptions) {}
  get running() { return !!this.child && this.child.exitCode === null && !this.child.killed; }
  get speechModelPath() { return join(this.options.modelsDir, 'whisper-large-v3'); }
  get insightsModelPath() { return join(this.options.modelsDir, 'qwen3-4b'); }
  get scriptPath() { return this.options.scriptPath ?? join(this.options.bundleDir, 'engine', 'local_service.py'); }
  readiness() {
    const bundle = this.options.bundleDir;
    return {
      engineReady: ['python/bin/python3.11', 'bin/ffmpeg', 'bin/ffprobe', 'bin/node', 'bin/vision-ocr'].every(name => existsSync(join(bundle, name))) && existsSync(this.scriptPath),
      speechModelReady: existsSync(join(this.speechModelPath, 'config.json')) && ['weights.npz', 'weights.safetensors'].some(name => existsSync(join(this.speechModelPath, name))),
      insightsModelReady: ['config.json', 'tokenizer.json', 'model.safetensors'].every(name => existsSync(join(this.insightsModelPath, name))),
    };
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = null; }
  }
  private async launch() {
    if (!Object.values(this.readiness()).every(Boolean)) throw new Error('The packaged engine or its local models are missing.');
    this.error = null;
    const runtime = join(this.options.dataDir, 'engine');
    const logs = join(this.options.dataDir, 'logs');
    for (const directory of [runtime, logs, join(runtime, 'tmp'), join(runtime, 'cache')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const logPath = join(logs, 'engine.log');
    if (existsSync(logPath) && statSync(logPath).size > 16 * 1024 * 1024) renameSync(logPath, logPath + '.previous');
    const log = openSync(logPath, 'a', 0o600);
    const environment = {
      PATH: [join(this.options.bundleDir, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: join(runtime, 'tmp'),
      XDG_CACHE_HOME: join(runtime, 'cache'), HF_HOME: join(runtime, 'cache', 'huggingface'),
      NUMBA_CACHE_DIR: join(runtime, 'cache', 'numba'), TIKTOKEN_CACHE_DIR: join(runtime, 'cache', 'tiktoken'),
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', TOKENIZERS_PARALLELISM: 'false',
      CLIPTEXT_BUNDLE_ROOT: this.options.bundleDir,
      CLIPTEXT_VISION_OCR_HELPER: join(this.options.bundleDir, 'bin', 'vision-ocr'),
    };
    const child = spawn(join(this.options.bundleDir, 'python', 'bin', 'python3.11'), ['-I', '-B', this.scriptPath], {
      cwd: runtime, env: environment, stdio: ['pipe', log, log], detached: true,
    });
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        if (!this.stopping && code !== 0) this.error = `The engine stopped (${signal ?? code ?? 'unknown'}).`;
      }
    });
    await new Promise<void>((accept, reject) => {
      let settled = false, logOpen = true;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (logOpen) { closeSync(log); logOpen = false; }
        if (error) reject(error); else accept();
      };
      child.stdin!.on('error', () => {
        this.error = 'The engine could not read its local startup configuration.';
        child.kill('SIGTERM');
        finish(new Error(this.error));
      });
      child.once('spawn', () => {
        child.stdin!.end(JSON.stringify({ api_url: this.options.origin, engine_key: this.options.engineKey,
          runtime_dir: runtime, speech_model_path: this.speechModelPath, insights_model_path: this.insightsModelPath,
          poll_seconds: 2, supervisor_pid: process.pid }) + '\n', (error?: Error | null) => { finish(error ?? undefined); });
      });
      child.once('error', error => { this.error = 'The packaged engine could not start.'; this.child = null; finish(error); });
    });
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = new Promise<void>(accept => {
      const timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }, 8000);
      child.once('exit', () => { clearTimeout(timer); accept(); });
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(timer); accept(); }
    });
    try { await this.stopping; } finally { this.stopping = null; if (this.child === child) this.child = null; }
  }
}
