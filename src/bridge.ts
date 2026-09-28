import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, chmod, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const PROTOCOL_VERSION = 1;
const HEARTBEAT_MAX_AGE_MS = 15_000;
const FUTURE_CLOCK_TOLERANCE_MS = 5_000;
const UNCERTAIN_REMOTE_CODES = new Set([
  "VERIFY_FAILED", "RESTORE_UNVERIFIED", "OUTCOME_UNKNOWN", "RENDER_STALE",
]);
const MUTATING_OPERATIONS = new Set([
  "import_photo", "reveal_photo",
  "create_working_copy", "checkpoint", "apply", "restore", "create_subject_mask", "adjust_mask",
]);

export class BridgeError extends Error {
  readonly code: string;
  readonly operation: string | undefined;
  readonly requestId: string | undefined;
  readonly outcomeUncertain: boolean;

  constructor(code: string, message: string, details: {
    operation?: string;
    requestId?: string;
    outcomeUncertain?: boolean;
    cause?: unknown;
  } = {}) {
    super(message, { cause: details.cause });
    this.name = "BridgeError";
    this.code = code;
    this.operation = details.operation;
    this.requestId = details.requestId;
    this.outcomeUncertain = details.outcomeUncertain ?? false;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export class FileBridge {
  readonly bridgeDir: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(bridgeDir: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
    if (typeof bridgeDir !== "string" || !bridgeDir.trim()) {
      throw new BridgeError("BRIDGE_CONFIG_ERROR", "bridgeDir must be a nonempty path.");
    }
    this.bridgeDir = resolve(bridgeDir);
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.pollMs = options.pollMs ?? 100;
    for (const [name, value] of [["timeoutMs", this.timeoutMs], ["pollMs", this.pollMs]] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new BridgeError("BRIDGE_CONFIG_ERROR", `${name} must be a positive finite number.`);
      }
    }
  }

  async status(): Promise<{ online: boolean; heartbeat?: unknown; bridgeDir: string }> {
    let heartbeat: unknown;
    try {
      heartbeat = JSON.parse(await readFile(join(this.bridgeDir, "heartbeat.json"), "utf8"));
    } catch (error) {
      if (hasCode(error, "ENOENT") || error instanceof SyntaxError) {
        return { online: false, bridgeDir: this.bridgeDir };
      }
      throw new BridgeError("BRIDGE_IO_ERROR", "Could not read the Lightroom bridge heartbeat.", { cause: error });
    }
    const timestamp = isRecord(heartbeat) ? heartbeat.timestamp : undefined;
    const status = isRecord(heartbeat) ? heartbeat.status : undefined;
    const age = typeof timestamp === "number" ? Date.now() - timestamp : Number.NaN;
    return {
      online: (status === "idle" || status === "busy") &&
        Number.isFinite(age) && age >= -FUTURE_CLOCK_TOLERANCE_MS && age <= HEARTBEAT_MAX_AGE_MS,
      heartbeat,
      bridgeDir: this.bridgeDir,
    };
  }

  async call<T = unknown>(operation: string, params: RecordValue = {}): Promise<T> {
    if (typeof operation !== "string" || !operation.trim() || !isRecord(params)) {
      throw new BridgeError("BRIDGE_CONFIG_ERROR", "An operation name and a parameter object are required.");
    }
    const id = randomUUID();
    const context = { operation, requestId: id };
    const requestsDir = join(this.bridgeDir, "requests");
    const responsesDir = join(this.bridgeDir, "responses");
    const lockPath = join(this.bridgeDir, "call.lock");
    const requestPath = join(requestsDir, `${id}.json`);
    const responsePath = join(responsesDir, `${id}.json`);
    let lockOwned = false;
    let submitted = false;

    try {
      for (const directory of [this.bridgeDir, requestsDir, responsesDir]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }

      let lock;
      try {
        lock = await open(lockPath, "wx", 0o600);
        lockOwned = true;
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw new BridgeError("BRIDGE_BUSY",
            "Another bridge call owns call.lock. Wait for it to finish. A lock left by a crashed process must be inspected before removal; it is never broken automatically.",
            context);
        }
        throw error;
      }
      try {
        await lock.writeFile(JSON.stringify({ id, pid: process.pid, timestamp: Date.now(), operation }), "utf8");
      } finally {
        await lock.close();
      }

      const issuedAt = Date.now();
      const deadlineAt = issuedAt + this.timeoutMs;
      const request = { protocolVersion: PROTOCOL_VERSION, id, operation, params, issuedAt, deadlineAt };
      const temporaryPath = join(requestsDir, `.${id}.tmp`);
      try {
        // Serialize before opening a file so cyclic/non-JSON parameters cannot leave a partial request.
        const serialized = JSON.stringify(request);
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(serialized, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, requestPath);
        submitted = true;
      } finally {
        await removeIfPresent(temporaryPath);
      }

      while (true) {
        let raw: string | undefined;
        try {
          raw = await readFile(responsePath, "utf8");
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
        if (raw !== undefined) {
          let response: unknown;
          try {
            response = JSON.parse(raw);
          } catch (error) {
            throw new BridgeError("BRIDGE_PROTOCOL_ERROR",
              "The bridge returned malformed JSON. The edit outcome is uncertain; reconcile Lightroom state before retrying.",
              { ...context, outcomeUncertain: true, cause: error });
          }
          if (!isRecord(response) || response.protocolVersion !== PROTOCOL_VERSION || response.id !== id ||
              (response.ok !== true && response.ok !== false)) {
            throw new BridgeError("BRIDGE_PROTOCOL_ERROR",
              "The bridge response has an invalid version, request ID, or status. The outcome is uncertain; reconcile Lightroom state before retrying.",
              { ...context, outcomeUncertain: true });
          }
          if (response.ok === true) {
            if (!Object.hasOwn(response, "result") || Object.hasOwn(response, "error")) {
              throw new BridgeError("BRIDGE_PROTOCOL_ERROR",
                "The successful response is missing its result or also contains an error. Reconcile Lightroom state before retrying.",
                { ...context, outcomeUncertain: true });
            }
            await removeIfPresent(responsePath);
            return response.result as T;
          }
          if (!isRecord(response.error) || typeof response.error.code !== "string" || !response.error.code.trim() ||
              typeof response.error.message !== "string" || !response.error.message.trim() || Object.hasOwn(response, "result") ||
              (Object.hasOwn(response.error, "outcomeUncertain") && typeof response.error.outcomeUncertain !== "boolean")) {
            throw new BridgeError("BRIDGE_PROTOCOL_ERROR",
              "The bridge returned an invalid error response. Reconcile Lightroom state before retrying.",
              { ...context, outcomeUncertain: true });
          }
          await removeIfPresent(responsePath);
          // Prefer the peer's knowledge of whether execution began. Older peers
          // lack this field, so retain uncertainty for failed verification and
          // unclassified exceptions in operations that can change Lightroom.
          const outcomeUncertain = typeof response.error.outcomeUncertain === "boolean"
            ? response.error.outcomeUncertain
            : UNCERTAIN_REMOTE_CODES.has(response.error.code) ||
              (response.error.code === "INTERNAL_ERROR" && MUTATING_OPERATIONS.has(operation));
          throw new BridgeError(response.error.code, response.error.message, { ...context, outcomeUncertain });
        }

        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw new BridgeError("BRIDGE_TIMEOUT",
            `No response arrived for ${operation} (${id}). The operation may still execute: its outcome is uncertain. The request was preserved. Reconcile Lightroom state before retrying; no automatic retry was performed.`,
            { ...context, outcomeUncertain: true });
        }
        await pause(Math.min(this.pollMs, remaining));
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("BRIDGE_IO_ERROR",
        submitted
          ? "Bridge communication failed after submission. The outcome is uncertain; reconcile Lightroom state before retrying."
          : "Could not prepare or submit the Lightroom bridge request.",
        { ...context, outcomeUncertain: submitted, cause: error });
    } finally {
      if (lockOwned) {
        // Do not unlink a lock replaced by an external recovery action.
        try {
          const owner: unknown = JSON.parse(await readFile(lockPath, "utf8"));
          if (isRecord(owner) && owner.id === id) await removeIfPresent(lockPath);
        } catch {
          // A missing, unreadable, or damaged lock is left for explicit inspection.
          // Cleanup must not replace the operation's result with a misleading failure.
        }
      }
    }
  }
}
