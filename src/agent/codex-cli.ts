import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionAgent, PhotoAgentError, type AgentStatus, type DecisionAgentOptions,
  type ModelRequest, type ModelResponse, type ModelTransport } from './core.ts';

/** Codex CLI the flags below were verified against; see scripts/check-codex-cli.ts. */
export const CODEX_MIN_VERSION = '0.153.4';
export const CODEX_ENABLED_FEATURE = 'skip_host_skill_discovery';
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin',
  'hooks', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use',
  'in_app_browser', 'in_app_local_automation', 'code_mode', 'code_mode_host', 'image_generation',
  'view_image', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'memories', 'sleep_tool',
];

/** Extracts "x.y.z" from `codex --version` output such as "codex-cli 0.153.4". */
export function parseCodexVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
export function isSupportedCodexVersion(version: readonly number[], minimum = CODEX_MIN_VERSION): boolean {
  const floor = parseCodexVersion(minimum)!;
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== floor[i]!) return version[i]! > floor[i]!;
  }
  return true;
}

export interface CodexArgsInput { model: string; cwd: string; schemaPath: string; outputPath: string; images: string[] }
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '--color', 'never', '--model', input.model, '--cd', input.cwd,
    '--output-schema', input.schemaPath, '--output-last-message', input.outputPath,
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'history.persistence="none"'];
  // Inputs are attached directly; no executable, browser, plug-in, connector,
  // or image-generation tools are needed.
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature);
  args.push('--enable', CODEX_ENABLED_FEATURE);
  for (const image of input.images) args.push('--image', image);
  args.push('-');
  return args;
}

export interface ProcessOptions {
  cwd: string; stdin?: string; signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number; captureOutput?: boolean;
}
export interface ProcessResult { code: number; stdout: string; stderr: string }
export type ProcessRunner = (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

/** Never forwards child output to a public stream; model JSONL is discarded. */
export const runBoundedProcess: ProcessRunner = async (executable, args, options) => {
  if (options.signal?.aborted) throw new PhotoAgentError('ABORTED', 'The photo decision was cancelled.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0;
    let failure: PhotoAgentError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    };
    const stop = (error: PhotoAgentError) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
      killTimer.unref();
    };
    const onAbort = () => stop(new PhotoAgentError('ABORTED', 'The photo decision was cancelled.'));
    const timeout = setTimeout(() => stop(new PhotoAgentError('TIMEOUT', 'The photo decision exceeded its time limit.')), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        stop(new PhotoAgentError('OUTPUT_LIMIT', 'The photo decision exceeded its output limit.'));
        return;
      }
      if (options.captureOutput) {
        if (stream === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.stdin.on('error', () => { /* Early process exit may close stdin. */ });
    child.on('error', () => { failure ??= new PhotoAgentError('UNAVAILABLE', 'Could not launch the Codex CLI.'); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (killTimer) { clearTimeout(killTimer); kill('SIGKILL'); }
      options.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? '');
  });
};

export interface CodexTransportOptions { binary?: string; model?: string; timeoutMs?: number; runner?: ProcessRunner }
export interface CodexPhotoAgentOptions extends CodexTransportOptions, DecisionAgentOptions {}

export class CodexTransport implements ModelTransport {
  readonly provider = 'codex-cli';
  readonly capabilities = { maxImages: 3, dataLeavesDevice: true };
  readonly model: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;
  constructor(options: CodexTransportOptions = {}) {
    this.model = options.model ?? process.env.RPA_MODEL ?? 'gpt-6-astra';
    this.binary = options.binary ?? process.env.RPA_CODEX_BIN ?? 'codex';
    this.timeoutMs = options.timeoutMs ?? 180_000;
    if (!this.model.trim() || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PhotoAgentError('INVALID_INPUT', 'A model and a positive time limit are required.');
    }
    this.runner = options.runner ?? runBoundedProcess;
  }

  async status(): Promise<AgentStatus> {
    const result = { available: false, model: this.model, provider: this.provider };
    try {
      const versionProbe = await this.runner(this.binary, ['--version'], {
        cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 16_384, captureOutput: true,
      });
      const version = versionProbe.code === 0 ? parseCodexVersion(versionProbe.stdout) : undefined;
      if (!version) return { ...result, message: 'Could not determine the Codex CLI version. Install Codex CLI ' + CODEX_MIN_VERSION + ' or newer.' };
      if (!isSupportedCodexVersion(version)) {
        return { ...result, message: `Codex CLI ${version.join('.')} is older than the tested ${CODEX_MIN_VERSION}. Update it before starting the photo agent.` };
      }
      const probe = await this.runner(this.binary, ['login', 'status'], {
        cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 16_384, captureOutput: true,
      });
      if (probe.code !== 0 || !/logged in/i.test(`${probe.stdout}
${probe.stderr}`)) {
        return { ...result, message: 'Sign in with codex login before starting the photo agent.' };
      }
      return { ...result, available: true };
    } catch {
      return { ...result, message: 'Codex CLI is unavailable. Install it and sign in with codex login.' };
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-photo-agent-decision-'));
    try {
      await chmod(cwd, 0o700);
      const schemaPath = join(cwd, 'decision.schema.json');
      const outputPath = join(cwd, 'decision.json');
      await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
      await writeFile(outputPath, '', { mode: 0o600 });
      const result = await this.runner(this.binary, buildCodexArgs({ model: this.model, cwd, schemaPath, outputPath,
        images: request.images }), {
        cwd, stdin: request.prompt, signal: request.signal, timeoutMs: this.timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      if (request.signal?.aborted) throw new PhotoAgentError('ABORTED', 'The photo decision was cancelled.');
      if (result.code !== 0) throw new PhotoAgentError('PROVIDER_FAILED', 'Codex could not complete the photo decision.');
      if ((await stat(outputPath)).size > 32_768) throw new PhotoAgentError('OUTPUT_LIMIT', 'The final decision exceeds the size limit.');
      return { text: await readFile(outputPath, 'utf8') };
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
}

/** The default demo agent: decisions through the signed-in Codex CLI. */
export class CodexPhotoAgent extends DecisionAgent {
  constructor(options: CodexPhotoAgentOptions = {}) {
    super(new CodexTransport(options), options);
  }
}
