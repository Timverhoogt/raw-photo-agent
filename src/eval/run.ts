import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionAgent } from '../agent/core.ts';
import { PhotoAgentError } from '../agent/core.ts';
import { grade, type ProbeCase } from './probes.ts';
import type { CallRecord } from './score.ts';

export interface RunOptions { concurrency: number; signal?: AbortSignal; onRecord?: (record: CallRecord, done: number, total: number) => void }

/**
 * Copies each attached preview to `<candidate id>.jpg` in a private folder, so no provider can
 * read the answer from a fixture filename such as reference.jpg or overexposed.jpg.
 */
export async function stageCase(testCase: ProbeCase, dir: string): Promise<ProbeCase> {
  const candidates = await Promise.all(testCase.input.candidates.map(async candidate => {
    const previewPath = join(dir, `${candidate.id}.jpg`);
    await copyFile(candidate.previewPath, previewPath);
    return { ...candidate, previewPath };
  }));
  return { ...testCase, input: { ...testCase.input, candidates } };
}

export async function runCase(agent: DecisionAgent, testCase: ProbeCase, signal?: AbortSignal): Promise<CallRecord> {
  const base = { probe: testCase.probe, fixtureId: testCase.fixture.id, faultId: testCase.fault?.id ?? null,
    severity: testCase.fault?.severity ?? null, repeat: testCase.repeat };
  try {
    const result = await agent.decideDetailed(testCase.input, signal);
    const d = result.decision;
    return { ...base, attempts: result.attempts, grade: grade(testCase, d),
      decision: d ? { action: d.action, candidateId: d.candidateId === testCase.referenceId ? 'reference' : d.candidateId === testCase.faultId ? 'fault'
        : d.candidateId === testCase.distractorId ? 'distractor' : d.candidateId,
        adjustments: d.adjustments, title: d.title, observation: d.observation, reason: d.reason } : null,
      ...(result.error ? { errorCode: result.error.code, error: result.error.message } : {}) };
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error instanceof PhotoAgentError ? error : new PhotoAgentError('HARNESS_ERROR', String(error));
    return { ...base, attempts: [], grade: grade(testCase, null), decision: null, errorCode: failure.code, error: failure.message };
  }
}

/** Runs cases with bounded concurrency; on abort, returns the records finished so far. */
export async function runCases(agent: DecisionAgent, cases: ProbeCase[], options: RunOptions): Promise<{ records: CallRecord[]; complete: boolean }> {
  const records: CallRecord[] = new Array(cases.length);
  let next = 0, done = 0;
  const staging = await mkdtemp(join(tmpdir(), 'raw-photo-agent-eval-'));
  const worker = async () => {
    while (next < cases.length && !options.signal?.aborted) {
      const index = next++;
      try {
        const caseDir = await mkdtemp(join(staging, 'case-'));
        records[index] = await runCase(agent, await stageCase(cases[index]!, caseDir), options.signal);
        await rm(caseDir, { recursive: true, force: true });
        options.onRecord?.(records[index]!, ++done, cases.length);
      } catch (error) { if (!options.signal?.aborted) throw error; }
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, cases.length)) }, worker)); }
  finally { await rm(staging, { recursive: true, force: true }); }
  const finished = records.filter(Boolean);
  return { records: finished, complete: finished.length === cases.length };
}
