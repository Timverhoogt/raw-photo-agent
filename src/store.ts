import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RunStatus = 'active' | 'awaiting_choice' | 'completed' | 'interrupted';

export interface Run {
  id: string;
  sourcePhotoId: string;
  workingPhotoId: string;
  intent: string;
  status: RunStatus;
  baselineSnapshotId: string | null;
  baselineStateToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  runId: string;
  parentId: string | null;
  snapshotId: string;
  stateToken: string;
  previewPath: string | null;
  direction: string | null;
  description: string | null;
  settings: unknown;
  createdAt: string;
}

export interface Choice {
  id: string;
  runId: string;
  candidateIds: string[];
  question: string;
  selectedCandidateId: string | null;
  feedback: string | null;
  createdAt: string;
  chosenAt: string | null;
}

export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  id?: string;
  sourcePhotoId: string;
  workingPhotoId: string;
  intent: string;
  baselineSnapshotId?: string;
  baselineStateToken?: string;
}

export interface AddCandidateInput {
  id?: string;
  runId: string;
  parentId?: string;
  snapshotId: string;
  stateToken: string;
  previewPath?: string;
  direction?: string;
  description?: string;
  settings?: unknown;
}

export interface CreateChoiceInput {
  id?: string;
  runId: string;
  candidateIds: string[];
  question: string;
}

type Row = Record<string, unknown>;

function requiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function optionalString(value: unknown, name: string): void {
  if (value !== undefined) requiredString(value, name);
}

// Stable JSON makes retries independent of object property insertion order.
function json(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Value must be JSON serializable');
  }
  if (serialized === undefined) throw new Error('Value must be JSON serializable');
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    }
    return item;
  }
  return JSON.stringify(sort(JSON.parse(serialized)));
}

function runFromRow(row: Row): Run {
  return { ...row } as unknown as Run;
}

function candidateFromRow(row: Row): Candidate {
  return { ...row, settings: JSON.parse(row.settings as string) } as unknown as Candidate;
}

function choiceFromRow(row: Row): Choice {
  return { ...row, candidateIds: JSON.parse(row.candidateIds as string) } as unknown as Choice;
}

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    requiredString(dbPath, 'dbPath');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY NOT NULL,
          sourcePhotoId TEXT NOT NULL,
          workingPhotoId TEXT NOT NULL,
          intent TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'awaiting_choice', 'completed', 'interrupted')),
          baselineSnapshotId TEXT,
          baselineStateToken TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS candidates (
          id TEXT PRIMARY KEY NOT NULL,
          runId TEXT NOT NULL REFERENCES runs(id),
          parentId TEXT REFERENCES candidates(id),
          snapshotId TEXT NOT NULL,
          stateToken TEXT NOT NULL,
          previewPath TEXT,
          direction TEXT,
          description TEXT,
          settings TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS candidates_by_run ON candidates(runId);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          runId TEXT NOT NULL REFERENCES runs(id),
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_by_run ON events(runId);
        CREATE TABLE IF NOT EXISTS choices (
          id TEXT PRIMARY KEY NOT NULL,
          runId TEXT NOT NULL REFERENCES runs(id),
          candidateIds TEXT NOT NULL,
          question TEXT NOT NULL,
          selectedCandidateId TEXT REFERENCES candidates(id),
          feedback TEXT,
          createdAt TEXT NOT NULL,
          chosenAt TEXT,
          CHECK ((selectedCandidateId IS NULL AND chosenAt IS NULL AND feedback IS NULL)
            OR (selectedCandidateId IS NOT NULL AND chosenAt IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS choices_by_run ON choices(runId);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  createRun(input: CreateRunInput): Run {
    optionalString(input.id, 'id');
    requiredString(input.sourcePhotoId, 'sourcePhotoId');
    requiredString(input.workingPhotoId, 'workingPhotoId');
    requiredString(input.intent, 'intent');
    optionalString(input.baselineSnapshotId, 'baselineSnapshotId');
    optionalString(input.baselineStateToken, 'baselineStateToken');
    const id = input.id ?? randomUUID();
    const fields = {
      sourcePhotoId: input.sourcePhotoId, workingPhotoId: input.workingPhotoId, intent: input.intent,
      baselineSnapshotId: input.baselineSnapshotId ?? null, baselineStateToken: input.baselineStateToken ?? null,
    };
    return this.transaction(() => {
      const existing = this.getRun(id);
      if (existing) {
        if (Object.entries(fields).some(([key, value]) => existing[key as keyof Run] !== value)) {
          throw new Error(`Run ID already exists with different content: ${id}`);
        }
        return existing;
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
        id, fields.sourcePhotoId, fields.workingPhotoId, fields.intent,
        fields.baselineSnapshotId, fields.baselineStateToken, now, now,
      );
      return this.getRun(id)!;
    });
  }

  getRun(id: string): Run | null {
    requiredString(id, 'id');
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? runFromRow(row) : null;
  }

  listRuns(): Run[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY rowid').all().map(runFromRow);
  }

  setRunStatus(id: string, status: RunStatus): void {
    this.requireRun(id);
    if (!['active', 'awaiting_choice', 'completed', 'interrupted'].includes(status)) {
      throw new Error(`Invalid run status: ${status}`);
    }
    this.db.prepare('UPDATE runs SET status = ?, updatedAt = ? WHERE id = ? AND status != ?')
      .run(status, new Date().toISOString(), id, status);
  }

  attachWorkingCopy(runId: string, photoId: string): Run {
    requiredString(photoId, 'photoId');
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (run.workingPhotoId === photoId) return run;
      if (run.workingPhotoId !== `pending:${runId}`) {
        throw new Error('Working copy is already assigned and cannot be changed');
      }
      if (this.db.prepare('SELECT id FROM candidates WHERE runId = ? LIMIT 1').get(runId)) {
        throw new Error('Cannot assign a working copy after candidates have been recorded');
      }
      this.db.prepare('UPDATE runs SET workingPhotoId = ?, updatedAt = ? WHERE id = ?')
        .run(photoId, new Date().toISOString(), runId);
      return this.getRun(runId)!;
    });
  }

  setBaseline(runId: string, candidateId: string): Run {
    requiredString(candidateId, 'candidateId');
    return this.transaction(() => {
      const run = this.requireRun(runId);
      const candidate = this.getCandidate(candidateId);
      if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
      if (candidate.runId !== runId) throw new Error('Baseline candidate belongs to another run');
      if (run.baselineSnapshotId === candidate.snapshotId && run.baselineStateToken === candidate.stateToken) return run;
      if (run.baselineSnapshotId !== null || run.baselineStateToken !== null) {
        throw new Error('Baseline is already assigned and cannot be changed');
      }
      this.db.prepare('UPDATE runs SET baselineSnapshotId = ?, baselineStateToken = ?, updatedAt = ? WHERE id = ?')
        .run(candidate.snapshotId, candidate.stateToken, new Date().toISOString(), runId);
      return this.getRun(runId)!;
    });
  }

  addCandidate(input: AddCandidateInput): Candidate {
    optionalString(input.id, 'id');
    requiredString(input.runId, 'runId');
    requiredString(input.snapshotId, 'snapshotId');
    requiredString(input.stateToken, 'stateToken');
    for (const key of ['parentId', 'previewPath', 'direction', 'description'] as const) optionalString(input[key], key);
    const id = input.id ?? randomUUID();
    const fields = {
      runId: input.runId, parentId: input.parentId ?? null, snapshotId: input.snapshotId,
      stateToken: input.stateToken, direction: input.direction ?? null,
      description: input.description ?? null, settings: json(input.settings ?? null),
    };
    return this.transaction(() => {
      this.requireRun(input.runId);
      const existing = this.getCandidate(id);
      if (existing) {
        const same = Object.entries(fields).every(([key, value]) =>
          key === 'settings' ? json(existing.settings) === value : existing[key as keyof Candidate] === value,
        );
        if (!same || (input.previewPath !== undefined && existing.previewPath !== input.previewPath)) {
          throw new Error(`Candidate ID already exists with different content: ${id}`);
        }
        return existing;
      }
      if (input.parentId) {
        const parent = this.getCandidate(input.parentId);
        if (!parent) throw new Error(`Parent candidate not found: ${input.parentId}`);
        if (parent.runId !== input.runId) throw new Error('Parent candidate belongs to another run');
      }
      this.db.prepare('INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, fields.runId, fields.parentId, fields.snapshotId, fields.stateToken,
        input.previewPath ?? null, fields.direction, fields.description, fields.settings, new Date().toISOString(),
      );
      return this.getCandidate(id)!;
    });
  }

  getCandidate(id: string): Candidate | null {
    requiredString(id, 'id');
    const row = this.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
    return row ? candidateFromRow(row) : null;
  }

  listCandidates(runId: string): Candidate[] {
    this.requireRun(runId);
    return this.db.prepare('SELECT * FROM candidates WHERE runId = ? ORDER BY rowid').all(runId).map(candidateFromRow);
  }

  setCandidatePreview(id: string, previewPath: string): void {
    requiredString(previewPath, 'previewPath');
    this.transaction(() => {
      const candidate = this.getCandidate(id);
      if (!candidate) throw new Error(`Candidate not found: ${id}`);
      if (candidate.previewPath !== null && candidate.previewPath !== previewPath) {
        throw new Error(`Candidate preview is already recorded: ${id}`);
      }
      this.db.prepare('UPDATE candidates SET previewPath = ? WHERE id = ? AND previewPath IS NULL').run(previewPath, id);
    });
  }

  addEvent(runId: string, type: string, payload: unknown): void {
    this.requireRun(runId);
    requiredString(type, 'type');
    this.db.prepare('INSERT INTO events (runId, type, payload, createdAt) VALUES (?, ?, ?, ?)')
      .run(runId, type, json(payload), new Date().toISOString());
  }

  listEvents(runId: string): RunEvent[] {
    this.requireRun(runId);
    return this.db.prepare('SELECT * FROM events WHERE runId = ? ORDER BY id').all(runId).map((row) =>
      ({ ...row, payload: JSON.parse(row.payload as string) }) as unknown as RunEvent,
    );
  }

  createChoice(input: CreateChoiceInput): Choice {
    optionalString(input.id, 'id');
    requiredString(input.runId, 'runId');
    requiredString(input.question, 'question');
    if (!Array.isArray(input.candidateIds) || input.candidateIds.length === 0) {
      throw new Error('Choice must contain at least one candidate');
    }
    for (const id of input.candidateIds) requiredString(id, 'candidateIds entry');
    if (new Set(input.candidateIds).size !== input.candidateIds.length) throw new Error('Choice candidate IDs must be unique');
    const id = input.id ?? randomUUID();
    const candidateIds = json(input.candidateIds);
    return this.transaction(() => {
      this.requireRun(input.runId);
      const existing = this.getChoice(id);
      if (existing) {
        if (existing.runId !== input.runId || existing.question !== input.question || json(existing.candidateIds) !== candidateIds) {
          throw new Error(`Choice ID already exists with different content: ${id}`);
        }
        return existing;
      }
      for (const candidateId of input.candidateIds) {
        const candidate = this.getCandidate(candidateId);
        if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
        if (candidate.runId !== input.runId) throw new Error('Choice candidate belongs to another run');
      }
      this.db.prepare('INSERT INTO choices VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)')
        .run(id, input.runId, candidateIds, input.question, new Date().toISOString());
      this.setRunStatus(input.runId, 'awaiting_choice');
      return this.getChoice(id)!;
    });
  }

  getChoice(id: string): Choice | null {
    requiredString(id, 'id');
    const row = this.db.prepare('SELECT * FROM choices WHERE id = ?').get(id);
    return row ? choiceFromRow(row) : null;
  }

  choose(choiceId: string, candidateId: string, feedback?: string): Choice {
    requiredString(choiceId, 'choiceId');
    requiredString(candidateId, 'candidateId');
    if (feedback !== undefined && typeof feedback !== 'string') throw new Error('feedback must be a string');
    return this.transaction(() => {
      const choice = this.getChoice(choiceId);
      if (!choice) throw new Error(`Choice not found: ${choiceId}`);
      const candidate = this.getCandidate(candidateId);
      if (!candidate || candidate.runId !== choice.runId || !choice.candidateIds.includes(candidateId)) {
        throw new Error('Selected candidate must belong to the run and be listed in the choice');
      }
      if (choice.selectedCandidateId !== null) {
        if (choice.selectedCandidateId !== candidateId || choice.feedback !== (feedback ?? null)) {
          throw new Error(`Choice already decided; its decision is immutable: ${choiceId}`);
        }
        return choice;
      }
      this.db.prepare('UPDATE choices SET selectedCandidateId = ?, feedback = ?, chosenAt = ? WHERE id = ?')
        .run(candidateId, feedback ?? null, new Date().toISOString(), choiceId);
      // Another outstanding comparison must not be implicitly answered.
      const pending = this.db.prepare('SELECT id FROM choices WHERE runId = ? AND selectedCandidateId IS NULL LIMIT 1').get(choice.runId);
      this.setRunStatus(choice.runId, pending ? 'awaiting_choice' : 'active');
      return this.getChoice(choiceId)!;
    });
  }

  listChoices(runId: string): Choice[] {
    this.requireRun(runId);
    return this.db.prepare('SELECT * FROM choices WHERE runId = ? ORDER BY rowid').all(runId).map(choiceFromRow);
  }
}
