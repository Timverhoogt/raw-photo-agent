import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export interface Logger { log(level: LogLevel, event: string, fields?: Record<string, unknown>): void }

export const noopLogger: Logger = { log() {} };

/**
 * Append-only JSON Lines log with one rotated generation (`<path>.1`).
 * Callers pass short event names and error messages only: never photo content,
 * intent text, previews, or model output. Logging must never break the caller.
 */
export class FileLogger implements Logger {
  private readonly path: string;
  private readonly maxBytes: number;
  constructor(path: string, maxBytes = 5 * 1024 * 1024) {
    this.path = path; this.maxBytes = maxBytes;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
    try {
      let size = 0;
      try { size = statSync(this.path).size; } catch { /* First write creates the file. */ }
      if (size >= this.maxBytes) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), level, event, pid: process.pid, ...fields })}\n`, { mode: 0o600 });
      if (size === 0) chmodSync(this.path, 0o600);
    } catch { /* A full disk or permission problem must not take the server down. */ }
  }
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { message: error.message, ...(typeof code === 'string' ? { code } : {}), ...(error.stack ? { stack: error.stack.split('\n').slice(0, 6).join('\n') } : {}) };
  }
  return { message: String(error) };
}
