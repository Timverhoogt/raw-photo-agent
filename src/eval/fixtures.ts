import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ADJUSTMENT_RANGES } from '../agent/core.ts';

export type Severity = 'obvious' | 'subtle';
export type Direction = 'increase' | 'decrease';
export interface FixDirection { key: string; direction: Direction }
export interface Fault {
  id: string; path: string; severity: Severity;
  /** The deliberate change from the reference, in Lightroom slider units. */
  delta: Record<string, number>;
  /** Slider moves that count as fixing it; derived from `delta` when the manifest omits it. */
  fix: FixDirection[];
}
export interface Fixture {
  id: string; dir: string; intent: string; source: 'lightroom' | 'synthetic';
  referencePath: string;
  /** Settings shown to the model for every candidate, so it must judge by pixels. */
  displayedSettings: Record<string, number>;
  faults: Fault[];
}

/** Sliders whose Lightroom default is 0; any other slider used by a fault needs an explicit reference value. */
export const ZERO_DEFAULTS: Readonly<Record<string, number>> = Object.fromEntries(
  ['Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012',
    'Clarity2012', 'Texture', 'Dehaze', 'Vibrance', 'Saturation', 'Tint'].map(key => [key, 0]));

/** Additional slider moves accepted as a fix, beyond reversing the faulted slider itself. */
const ALTERNATIVE_FIXES: Record<string, Partial<Record<Direction, FixDirection[]>>> = {
  Exposure2012: {
    increase: [{ key: 'Highlights2012', direction: 'decrease' }, { key: 'Whites2012', direction: 'decrease' }],
    decrease: [{ key: 'Shadows2012', direction: 'increase' }, { key: 'Whites2012', direction: 'increase' }],
  },
  Saturation: { increase: [{ key: 'Vibrance', direction: 'decrease' }], decrease: [{ key: 'Vibrance', direction: 'increase' }] },
  Vibrance: { increase: [{ key: 'Saturation', direction: 'decrease' }], decrease: [{ key: 'Saturation', direction: 'increase' }] },
  Blacks2012: { decrease: [{ key: 'Shadows2012', direction: 'increase' }] },
};

export function defaultFix(delta: Record<string, number>): FixDirection[] {
  const fixes: FixDirection[] = [];
  for (const [key, value] of Object.entries(delta)) {
    const faultDirection: Direction = value > 0 ? 'increase' : 'decrease';
    fixes.push({ key, direction: faultDirection === 'increase' ? 'decrease' : 'increase' });
    fixes.push(...(ALTERNATIVE_FIXES[key]?.[faultDirection] ?? []));
  }
  return fixes;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function invalid(where: string, message: string): never { throw new Error(`${where}: ${message}`); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sliders(value: unknown, where: string, allowZero: boolean): Record<string, number> {
  if (!record(value)) invalid(where, 'must be an object of Lightroom slider values.');
  for (const [key, number] of Object.entries(value)) {
    if (!Object.hasOwn(ADJUSTMENT_RANGES, key)) invalid(where, `unsupported slider ${key}.`);
    if (typeof number !== 'number' || !Number.isFinite(number) || (!allowZero && number === 0)) invalid(where, `${key} must be a ${allowZero ? '' : 'nonzero '}number.`);
  }
  return value as Record<string, number>;
}
async function jpegFile(dir: string, name: unknown, where: string): Promise<string> {
  if (typeof name !== 'string' || !/^[\w.-]+\.jpe?g$/i.test(name)) invalid(where, 'must name a .jpg file inside the fixture folder.');
  const path = join(dir, name);
  const info = await stat(path).catch(() => invalid(where, `${name} does not exist.`));
  if (!info.isFile()) invalid(where, `${name} is not a file.`);
  return path;
}

export async function loadFixture(dir: string): Promise<Fixture> {
  const where = join(dir, 'fixture.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(where, 'utf8')); } catch (error) { invalid(where, (error as Error).message); }
  if (!record(raw)) invalid(where, 'must be a JSON object.');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) invalid(where, 'id must be lowercase letters, digits and dashes.');
  if (typeof raw.intent !== 'string' || !raw.intent.trim() || raw.intent.length > 4000) invalid(where, 'intent must be nonempty text.');
  if (raw.source !== 'lightroom' && raw.source !== 'synthetic') invalid(where, 'source must be "lightroom" or "synthetic".');
  if (!record(raw.reference)) invalid(where, 'reference must be an object.');
  const referencePath = await jpegFile(dir, raw.reference.file, `${where} reference.file`);
  const displayedSettings = { ...ZERO_DEFAULTS, ...sliders(raw.reference.settings ?? {}, `${where} reference.settings`, true) };
  if (!Array.isArray(raw.faults) || !raw.faults.length) invalid(where, 'faults must be a nonempty array.');
  const faults: Fault[] = [];
  for (const [index, entry] of raw.faults.entries()) {
    const at = `${where} faults[${index}]`;
    if (!record(entry)) invalid(at, 'must be an object.');
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) invalid(at, 'id must be lowercase letters, digits and dashes.');
    if (faults.some(fault => fault.id === entry.id)) invalid(at, `duplicate fault id ${entry.id}.`);
    if (entry.severity !== 'obvious' && entry.severity !== 'subtle') invalid(at, 'severity must be "obvious" or "subtle".');
    const delta = sliders(entry.delta, `${at}.delta`, false);
    if (!Object.keys(delta).length) invalid(at, 'delta must change at least one slider.');
    let fix: FixDirection[];
    if (entry.fix === undefined) fix = defaultFix(delta);
    else {
      if (!Array.isArray(entry.fix) || !entry.fix.length) invalid(at, 'fix must be a nonempty array.');
      fix = entry.fix.map((item, i) => {
        if (!record(item) || typeof item.key !== 'string' || !Object.hasOwn(ADJUSTMENT_RANGES, item.key) ||
            (item.direction !== 'increase' && item.direction !== 'decrease')) invalid(`${at}.fix[${i}]`, 'needs a supported key and increase/decrease.');
        return { key: item.key, direction: item.direction };
      });
    }
    for (const key of new Set([...Object.keys(delta), ...fix.map(item => item.key)])) {
      if (displayedSettings[key] === undefined) invalid(at, `reference.settings must give the starting value of ${key} (it has no zero default).`);
    }
    faults.push({ id: entry.id, path: await jpegFile(dir, entry.file, `${at}.file`), severity: entry.severity, delta, fix });
  }
  return { id: raw.id, dir: resolve(dir), intent: raw.intent.trim(), source: raw.source, referencePath: resolve(referencePath), displayedSettings, faults: faults.map(f => ({ ...f, path: resolve(f.path) })) };
}

/** Loads every subfolder containing fixture.json, sorted by folder name. */
export async function loadFixtures(root: string): Promise<Fixture[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => invalid(root, 'fixture folder not found.'));
  const fixtures: Fixture[] = [];
  for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(root, entry.name);
    if (await stat(join(dir, 'fixture.json')).then(() => true, () => false)) fixtures.push(await loadFixture(dir));
  }
  const ids = fixtures.map(f => f.id);
  if (new Set(ids).size !== ids.length) invalid(root, 'fixture ids must be unique.');
  return fixtures;
}
