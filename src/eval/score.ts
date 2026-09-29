import type { DecisionAttempt } from '../agent/core.ts';
import type { Grade, ProbeName } from './probes.ts';

export interface Thresholds {
  tier0: { validFirstTry: number; validAfterRepair: number; p95LatencyMs: number; minImages: number; minCalls: number };
  tier1: { obvious: number; subtle: number; minItems: number };
  tier2: { keepBetter: number; leaveAlone: number; consistency: number; minItems: number };
}
export const DEFAULT_THRESHOLDS: Thresholds = {
  tier0: { validFirstTry: 0.97, validAfterRepair: 0.995, p95LatencyMs: 60_000, minImages: 3, minCalls: 30 },
  tier1: { obvious: 0.9, subtle: 0.7, minItems: 10 },
  tier2: { keepBetter: 0.8, leaveAlone: 0.8, consistency: 0.8, minItems: 5 },
};

export function mergeThresholds(override: unknown): Thresholds {
  const merged = structuredClone(DEFAULT_THRESHOLDS) as unknown as Record<string, Record<string, number>>;
  if (override === undefined) return merged as unknown as Thresholds;
  if (!override || typeof override !== 'object') throw new Error('Thresholds must be a JSON object.');
  for (const [tier, values] of Object.entries(override)) {
    if (!merged[tier] || !values || typeof values !== 'object') throw new Error(`Unknown threshold group ${tier}.`);
    for (const [key, value] of Object.entries(values)) {
      if (!(key in merged[tier]!) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid threshold ${tier}.${key}.`);
      merged[tier]![key] = value;
    }
  }
  return merged as unknown as Thresholds;
}

export interface CallRecord {
  probe: ProbeName; fixtureId: string; faultId: string | null; severity: 'obvious' | 'subtle' | null; repeat: number;
  decision: { action: string; candidateId: string | null; adjustments: Record<string, number>; title: string; observation: string; reason: string } | null;
  grade: Grade;
  attempts: DecisionAttempt[];
  errorCode?: string;
  error?: string;
}

export type Verdict = 'pass' | 'fail' | 'insufficient' | 'not-measured';
export interface Metric { value: number | null; n: number; threshold?: number; direction?: 'min' | 'max'; pass?: boolean }
export interface Scorecard {
  tier0: { verdict: Verdict; calls: number; validFirstTry: Metric; validAfterRepair: Metric; p95LatencyMs: Metric; maxImages: Metric;
    providerErrors: number; refusals: number; otherModelServed: number; inputTokens: number; outputTokens: number };
  tier1: { verdict: Verdict; obvious: Metric; subtle: Metric; byProbe: Record<string, Metric>; byFault: Record<string, Metric> };
  tier2: { verdict: Verdict; keepBetter: Metric; leaveAlone: Metric; consistency: Metric; falseRestore: Metric; overprocessedEdits: number };
  verdict: Verdict;
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}
function metric(value: number | null, n: number, threshold?: number, direction: 'min' | 'max' = 'min'): Metric {
  const pass = threshold === undefined || value === null ? undefined : direction === 'min' ? value >= threshold : value <= threshold;
  return { value, n, ...(threshold !== undefined ? { threshold, direction } : {}), ...(pass !== undefined ? { pass } : {}) };
}
function verdictOf(metrics: Metric[], enough: boolean): Verdict {
  const measured = metrics.filter(m => m.value !== null && m.threshold !== undefined);
  if (!measured.length) return 'not-measured';
  if (measured.some(m => m.pass === false)) return 'fail';
  return enough ? 'pass' : 'insufficient';
}
/** Groups records into items (one fixture × fault × probe) and averages each item's repeats. */
function itemMeans(records: CallRecord[], score: (r: CallRecord) => number | null) {
  const items = new Map<string, number[]>();
  for (const r of records) {
    const value = score(r);
    if (value === null) continue;
    const key = `${r.fixtureId}\u0000${r.faultId ?? ''}\u0000${r.probe}`;
    items.set(key, [...(items.get(key) ?? []), value]);
  }
  return [...items.values()].map(values => mean(values)!);
}

export function score(records: CallRecord[], context: { model: string; maxImages: number }, thresholds: Thresholds = DEFAULT_THRESHOLDS): Scorecard {
  const t0 = thresholds.tier0, t1 = thresholds.tier1, t2 = thresholds.tier2;
  // Tier 0: every call counts, whatever its probe.
  const latencies = records.filter(r => r.attempts.length).map(r => r.attempts.reduce((sum, a) => sum + a.latencyMs, 0));
  const usage = records.flatMap(r => r.attempts.map(a => a.usage).filter(u => u !== undefined));
  const finalCodes = records.filter(r => !r.decision).map(r => r.errorCode ?? 'UNKNOWN');
  const tier0Metrics = {
    validFirstTry: metric(mean(records.map(r => r.attempts[0]?.ok ? 1 : 0)), records.length, t0.validFirstTry),
    validAfterRepair: metric(mean(records.map(r => r.decision ? 1 : 0)), records.length, t0.validAfterRepair),
    p95LatencyMs: metric(percentile(latencies, 0.95), latencies.length, t0.p95LatencyMs, 'max'),
    maxImages: metric(context.maxImages, 1, t0.minImages),
  };
  const tier0 = {
    verdict: verdictOf(Object.values(tier0Metrics), records.length >= t0.minCalls), calls: records.length, ...tier0Metrics,
    providerErrors: finalCodes.filter(code => code !== 'INVALID_DECISION' && code !== 'PROVIDER_REFUSED').length,
    refusals: records.filter(r => r.attempts.some(a => a.errorCode === 'PROVIDER_REFUSED')).length,
    otherModelServed: usage.filter(u => u.servedModel && !u.servedModel.startsWith(context.model)).length,
    inputTokens: usage.reduce((sum, u) => sum + (u.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, u) => sum + (u.outputTokens ?? 0), 0),
  };

  // Tier 1: accuracy on known faults, by severity.
  const tier1Records = records.filter(r => r.probe === 'pick-better' || r.probe === 'fix-fault');
  const pass = (r: CallRecord) => r.grade.pass ? 1 : 0;
  const bySeverity = (severity: string) => itemMeans(tier1Records.filter(r => r.severity === severity), pass);
  const obviousItems = bySeverity('obvious'), subtleItems = bySeverity('subtle');
  const group = (key: (r: CallRecord) => string) => {
    const out: Record<string, Metric> = {};
    for (const name of new Set(tier1Records.map(key))) {
      const items = itemMeans(tier1Records.filter(r => key(r) === name), pass);
      out[name] = metric(mean(items), items.length);
    }
    return out;
  };
  const tier1Metrics = {
    obvious: metric(mean(obviousItems), obviousItems.length, t1.obvious),
    subtle: metric(mean(subtleItems), subtleItems.length, t1.subtle),
  };
  const tier1 = { verdict: verdictOf(Object.values(tier1Metrics), obviousItems.length + subtleItems.length >= t1.minItems),
    ...tier1Metrics, byProbe: group(r => r.probe), byFault: group(r => r.faultId ?? '') };

  // Tier 2: restraint on good renders, and whether repeated calls agree.
  // Gated separately: many easy keep-better items must not hide an over-eager edit of a good photo.
  const keepItems = itemMeans(records.filter(r => r.probe === 'keep-better'), pass);
  const aloneItems = itemMeans(records.filter(r => r.probe === 'leave-alone'), pass);
  const guard = records.filter(r => r.probe === 'keep-better');
  const repeatedGroups = new Map<string, string[]>();
  for (const r of records) {
    const key = `${r.fixtureId}\u0000${r.faultId ?? ''}\u0000${r.probe}`;
    repeatedGroups.set(key, [...(repeatedGroups.get(key) ?? []), r.grade.outcome]);
  }
  const consistent = [...repeatedGroups.values()].filter(outcomes => outcomes.length >= 2).map(outcomes => {
    const counts = new Map<string, number>();
    for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    return Math.max(...counts.values()) >= Math.ceil(t2.consistency * outcomes.length) ? 1 : 0;
  });
  const tier2Metrics = {
    keepBetter: metric(mean(keepItems), keepItems.length, t2.keepBetter),
    leaveAlone: metric(mean(aloneItems), aloneItems.length, t2.leaveAlone),
    consistency: metric(mean(consistent), consistent.length, t2.consistency),
  };
  const enoughTier2 = keepItems.length >= t2.minItems && aloneItems.length >= t2.minItems && consistent.length > 0;
  const tier2 = { verdict: verdictOf(Object.values(tier2Metrics), enoughTier2),
    ...tier2Metrics,
    falseRestore: metric(mean(guard.map(r => r.grade.falseRestore ? 1 : 0)), guard.length),
    overprocessedEdits: records.filter(r => r.grade.overprocessed).length };

  const verdicts = [tier0.verdict, tier1.verdict, tier2.verdict];
  const verdict: Verdict = verdicts.includes('fail') ? 'fail' : verdicts.every(v => v === 'pass') ? 'pass'
    : verdicts.includes('insufficient') ? 'insufficient' : 'not-measured';
  return { tier0, tier1, tier2, verdict };
}

const pct = (m: Metric) => m.value === null ? '—' : `${(m.value * 100).toFixed(1)}%`;
const secs = (m: Metric) => m.value === null ? '—' : `${(m.value / 1000).toFixed(1)} s`;
const mark = (m: Metric) => m.pass === undefined ? '' : m.pass ? ' ✓' : ' ✗';
const bar = (m: Metric, format: (m: Metric) => string) => m.threshold === undefined ? '' :
  `${m.direction === 'max' ? '≤' : '≥'} ${format({ ...m, value: m.threshold })}`;

/** Rows of [label, per-scorecard values, threshold] for one or more scorecards. */
export function scorecardRows(cards: Scorecard[]): Array<[string, string[], string]> {
  const row = (label: string, pick: (c: Scorecard) => Metric, format: (m: Metric) => string): [string, string[], string] =>
    [label, cards.map(c => `${format(pick(c))} (n=${pick(c).n})${mark(pick(c))}`), bar(pick(cards[0]!), format)];
  const plain = (label: string, value: (c: Scorecard) => string): [string, string[], string] => [label, cards.map(value), ''];
  return [
    plain('Tier 0 · hard gates', c => c.tier0.verdict.toUpperCase()),
    row('  valid first try', c => c.tier0.validFirstTry, pct),
    row('  valid after one repair', c => c.tier0.validAfterRepair, pct),
    row('  p95 latency', c => c.tier0.p95LatencyMs, secs),
    row('  images accepted per request', c => c.tier0.maxImages, m => m.value === null ? '—' : String(m.value)),
    plain('  provider errors / refusals', c => `${c.tier0.providerErrors} / ${c.tier0.refusals}`),
    plain('  tokens in / out', c => `${c.tier0.inputTokens.toLocaleString('en')} / ${c.tier0.outputTokens.toLocaleString('en')}`),
    plain('Tier 1 · perception', c => c.tier1.verdict.toUpperCase()),
    row('  obvious faults', c => c.tier1.obvious, pct),
    row('  subtle faults', c => c.tier1.subtle, pct),
    plain('Tier 2 · restraint', c => c.tier2.verdict.toUpperCase()),
    row('  keeps the better render', c => c.tier2.keepBetter, pct),
    row('  leaves a good render alone', c => c.tier2.leaveAlone, pct),
    row('  same decision on repeat', c => c.tier2.consistency, pct),
    row('  restored a worse render', c => c.tier2.falseRestore, pct),
    plain('  overprocessing edits', c => String(c.tier2.overprocessedEdits)),
    plain('Overall', c => c.verdict.toUpperCase()),
  ];
}

export function formatTable(headers: string[], rows: Array<[string, string[], string]>): string {
  const table = [headers, ...rows.map(([label, values, threshold]) => [label, ...values, threshold])];
  const widths = headers.map((_, i) => Math.max(...table.map(r => (r[i] ?? '').length)));
  return table.map((r, index) => {
    const line = r.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
    return index === 0 ? `${line}\n${widths.map(w => '─'.repeat(w)).join('  ')}` : line;
  }).join('\n');
}
