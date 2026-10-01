import { createHash } from 'node:crypto';
import { requiresDetailEvidence } from '../agent/core.ts';
import type { Decision, DecisionInput } from '../agent/core.ts';
import type { Fault, Fixture } from './fixtures.ts';

/**
 * pick-better  latest = fault; earlier checkpoints = reference and another fault, in shuffled order
 *              → should restore the reference (tier 1). Sends three previews, like the live demo.
 * fix-fault    only the fault → should edit a faulted slider the right way, never the wrong way (tier 1)
 * keep-better  latest = reference, earlier checkpoint = fault → must not restore; changes stay small (tier 2)
 * leave-alone  only the reference → finish, ask, or change little (tier 2)
 */
export const PROBES = ['pick-better', 'fix-fault', 'keep-better', 'leave-alone'] as const;
export type ProbeName = typeof PROBES[number];

export interface ProbeCase {
  probe: ProbeName; fixture: Fixture; fault: Fault | null; repeat: number;
  input: DecisionInput; referenceId: string; faultId: string | null;
  /** pick-better only: a second faulty render offered as a wrong answer. */
  distractorId: string | null;
}

/** Opaque, stable candidate IDs so names never reveal which render is the reference. */
function opaqueId(...parts: string[]) {
  return `c-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10)}`;
}

export function buildCase(probe: ProbeName, fixture: Fixture, fault: Fault | null, repeat: number): ProbeCase {
  if (probe === 'fix-fault' && fault && fault.fix.every(({ key }) => requiresDetailEvidence({ [key]: 0 }))) {
    throw new Error(`Fixture ${fixture.id}, fault ${fault.id}: fix-fault requires matching detail crops for every accepted fix. ` +
      'This single-decision harness has no crop/inspection support. Omit fix-fault from --probes or supply a valid global alternative fix.');
  }
  const settings = fixture.displayedSettings;
  const referenceId = opaqueId(fixture.id, fault?.id ?? '', probe, 'reference');
  const faultId = fault ? opaqueId(fixture.id, fault.id, probe, 'fault') : null;
  const reference = { id: referenceId, previewPath: fixture.referencePath, settings };
  const faulty = fault && faultId ? { id: faultId, previewPath: fault.path, settings } : null;
  const others = fault ? fixture.faults.filter(f => f.id !== fault.id) : [];
  const distractorFault = probe === 'pick-better' && others.length ? others[fixture.faults.indexOf(fault!) % others.length]! : null;
  const distractorId = distractorFault ? opaqueId(fixture.id, fault!.id, probe, 'distractor') : null;
  const latest = 'Latest edit', earlier = 'Earlier checkpoint';
  const adjustmentNote = [{ title: 'Adjustment', text: 'A global adjustment to the earlier checkpoint produced the latest edit.' }];
  const base = { intent: fixture.intent, feedback: [], remainingEdits: 3 };
  let input: DecisionInput;
  if (probe === 'pick-better' && faulty) {
    const comparisons = [{ ...reference, description: earlier },
      ...(distractorFault ? [{ id: distractorId!, previewPath: distractorFault.path, settings, description: earlier }] : [])];
    // Shuffle deterministically so the reference is not always the second attachment.
    if (parseInt(referenceId.slice(2, 4), 16) % 2) comparisons.reverse();
    input = { ...base, currentCandidateId: faulty.id, history: adjustmentNote, candidates: [{ ...faulty, description: latest }, ...comparisons] };
  } else if (probe === 'keep-better' && faulty) {
    input = { ...base, currentCandidateId: reference.id, history: adjustmentNote,
      candidates: [{ ...reference, description: latest }, { ...faulty, description: earlier }] };
  } else if (probe === 'fix-fault' && faulty) {
    input = { ...base, currentCandidateId: faulty.id, history: [], candidates: [{ ...faulty, description: 'Current render' }] };
  } else if (probe === 'leave-alone') {
    input = { ...base, currentCandidateId: reference.id, history: [], candidates: [{ ...reference, description: 'Current render' }] };
  } else throw new Error(`Probe ${probe} needs ${fault ? 'no' : 'a'} fault.`);
  return { probe, fixture, fault, repeat, input, referenceId, faultId, distractorId };
}

/** Largest change that still counts as a small, restrained edit. */
export const SMALL_STEP: Readonly<Record<string, number>> = {
  Exposure2012: 0.35, Temperature: 400, Tint: 8, SharpenRadius: 0.3,
};
const DEFAULT_SMALL_STEP = 15;
/** Increases above this on these sliders count as overprocessing. */
export const OVERPROCESSING: Readonly<Record<string, number>> = {
  Saturation: 25, Vibrance: 25, Clarity2012: 25, Texture: 25, Dehaze: 25, Contrast2012: 25, Sharpness: 40,
};
const EPSILON = 1e-6;

export interface Grade {
  /** Tier 1 probes: the correct outcome. Tier 2 probes: restrained and, for keep-better, no restore to the fault. */
  pass: boolean;
  restrained: boolean | null;
  falseRestore: boolean | null;
  overprocessed: boolean;
  /** Coarse outcome used to measure repeatability. */
  outcome: string;
}

function change(decision: Decision, key: string, settings: Record<string, number>) {
  const value = decision.adjustments[key];
  return value === undefined ? 0 : value - (settings[key] ?? 0);
}
export function isRestrained(decision: Decision, settings: Record<string, number>) {
  if (decision.action === 'finish' || decision.action === 'ask') return true;
  if (decision.action !== 'edit') return false;
  return Object.keys(decision.adjustments).every(key => Math.abs(change(decision, key, settings)) <= (SMALL_STEP[key] ?? DEFAULT_SMALL_STEP) + EPSILON);
}
export function isOverprocessed(decision: Decision, settings: Record<string, number>) {
  return decision.action === 'edit' && Object.entries(OVERPROCESSING).some(([key, limit]) => change(decision, key, settings) > limit + EPSILON);
}

export function grade(testCase: ProbeCase, decision: Decision | null): Grade {
  if (!decision) return { pass: false, restrained: null, falseRestore: null, overprocessed: false, outcome: 'invalid' };
  const settings = testCase.fixture.displayedSettings;
  const target = decision.candidateId === testCase.referenceId ? 'reference' : decision.candidateId === testCase.faultId ? 'fault'
    : decision.candidateId === testCase.distractorId ? 'distractor' : 'none';
  const outcome = `${decision.action}:${target}`;
  const overprocessed = isOverprocessed(decision, settings);
  switch (testCase.probe) {
    case 'pick-better':
      return { pass: decision.action === 'restore' && target === 'reference', restrained: null, falseRestore: null, overprocessed, outcome };
    case 'fix-fault': {
      const fault = testCase.fault!;
      const helps = decision.action === 'edit' && fault.fix.some(({ key, direction }) => {
        const moved = change(decision, key, settings);
        return direction === 'increase' ? moved > EPSILON : moved < -EPSILON;
      });
      const worsens = decision.action === 'edit' && Object.entries(fault.delta).some(([key, delta]) => change(decision, key, settings) * Math.sign(delta) > EPSILON);
      return { pass: helps && !worsens, restrained: null, falseRestore: null, overprocessed, outcome };
    }
    case 'keep-better': {
      const falseRestore = decision.action === 'restore';
      const restrained = isRestrained(decision, settings);
      return { pass: !falseRestore && restrained, restrained, falseRestore, overprocessed, outcome };
    }
    case 'leave-alone': {
      const restrained = isRestrained(decision, settings);
      return { pass: restrained, restrained, falseRestore: null, overprocessed, outcome };
    }
  }
}

export interface PlanOptions { probes: readonly ProbeName[]; repeats: number; repeatFaults: number }
/**
 * Every fault runs pick-better, fix-fault and keep-better once; leave-alone runs once per fixture.
 * Repeatability: leave-alone and pick-better on the first `repeatFaults` faults run `repeats` times in total.
 */
export function planCases(fixtures: Fixture[], options: PlanOptions): ProbeCase[] {
  const cases: ProbeCase[] = [];
  const times = (n: number, make: (repeat: number) => ProbeCase) => { for (let r = 0; r < n; r++) cases.push(make(r)); };
  for (const fixture of fixtures) {
    for (const [index, fault] of fixture.faults.entries()) {
      for (const probe of ['pick-better', 'fix-fault', 'keep-better'] as const) {
        if (!options.probes.includes(probe)) continue;
        const repeated = probe === 'pick-better' && index < options.repeatFaults;
        times(repeated ? Math.max(1, options.repeats) : 1, r => buildCase(probe, fixture, fault, r));
      }
    }
    if (options.probes.includes('leave-alone')) times(Math.max(1, options.repeats), r => buildCase('leave-alone', fixture, null, r));
  }
  return cases;
}
