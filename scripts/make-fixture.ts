// Builds a synthetic evaluation fixture from one well-edited JPEG:
//   node scripts/make-fixture.ts --input good.jpg --id heron --intent "Natural wildlife; keep feather detail" [--out fixtures]
// Faults are sharp approximations of Lightroom slider changes. Prefer Lightroom-rendered
// fixtures for decisions that matter; see docs/evaluation.md.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp, { type Sharp } from 'sharp';

type Op = (image: Sharp) => Sharp | Promise<Sharp>;
/** Darkens only tones below `knee` (0–1): f(v) = v·(v/knee)^power, continuous at the knee, highlights untouched. */
const crushShadows = (knee: number, power: number): Op => async image => {
  const lut = Array.from({ length: 256 }, (_, v) => v / 255 >= knee ? v : Math.round(v * (v / 255 / knee) ** power));
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i++) data[i] = lut[data[i]!]!;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
};
const ev = (stops: number) => 2 ** (stops / 2.2); // one stop in linear light, approximated in sRGB
const whiteBalance = (red: number, blue: number): Op => image => image.recomb([[red, 0, 0], [0, 1, 0], [0, 0, blue]]);

export const SYNTHETIC_FAULTS: Array<{ id: string; severity: 'obvious' | 'subtle'; delta: Record<string, number>; apply: Op }> = [
  { id: 'overexposed', severity: 'obvious', delta: { Exposure2012: 2 }, apply: image => image.linear(ev(2), 0) },
  { id: 'underexposed', severity: 'obvious', delta: { Exposure2012: -2 }, apply: image => image.linear(ev(-2), 0) },
  { id: 'oversaturated', severity: 'obvious', delta: { Saturation: 80 }, apply: image => image.modulate({ saturation: 1.9 }) },
  { id: 'too-warm', severity: 'obvious', delta: { Temperature: 3000 }, apply: whiteBalance(1.15, 0.8) },
  { id: 'too-cool', severity: 'obvious', delta: { Temperature: -3000 }, apply: whiteBalance(0.82, 1.18) },
  { id: 'crushed-blacks', severity: 'obvious', delta: { Blacks2012: -80 }, apply: crushShadows(0.4, 1.6) },
  { id: 'overclarity', severity: 'obvious', delta: { Clarity2012: 100 },
    apply: image => image.clahe({ width: 64, height: 64, maxSlope: 6 }).sharpen({ sigma: 2, m1: 0, m2: 3 }) },
  { id: 'slightly-bright', severity: 'subtle', delta: { Exposure2012: 0.5 }, apply: image => image.linear(ev(0.5), 0) },
  { id: 'slightly-saturated', severity: 'subtle', delta: { Saturation: 30 }, apply: image => image.modulate({ saturation: 1.3 }) },
  { id: 'slightly-warm', severity: 'subtle', delta: { Temperature: 800 }, apply: whiteBalance(1.05, 0.93) },
  { id: 'slightly-crushed', severity: 'subtle', delta: { Blacks2012: -25 }, apply: crushShadows(0.22, 0.8) },
];

export async function makeSyntheticFixture(options: { input: string | Buffer; id: string; intent: string; out: string; longEdge?: number }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.id)) throw new Error('--id must be lowercase letters, digits and dashes.');
  const edge = options.longEdge ?? 2048;
  if (!Number.isInteger(edge) || edge < 256 || edge > 4096) throw new Error('--long-edge must be an integer from 256 to 4096.');
  const dir = join(options.out, options.id);
  await mkdir(dir, { recursive: true });
  const reference = await sharp(options.input).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb').removeAlpha().toBuffer();
  const save = (image: Sharp, name: string) => image.jpeg({ quality: 92 }).toFile(join(dir, name));
  await save(sharp(reference), 'reference.jpg');
  for (const fault of SYNTHETIC_FAULTS) await save(await fault.apply(sharp(reference)), `${fault.id}.jpg`);
  const manifest = {
    id: options.id, intent: options.intent, source: 'synthetic',
    reference: { file: 'reference.jpg', settings: { Temperature: 5500, Tint: 0 } },
    faults: SYNTHETIC_FAULTS.map(({ id, severity, delta }) => ({ id, file: `${id}.jpg`, severity, delta })),
  };
  await writeFile(join(dir, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, id: { type: 'string' }, intent: { type: 'string' },
    out: { type: 'string', default: 'fixtures' }, 'long-edge': { type: 'string', default: '2048' },
  } });
  if (!values.input || !values.id || !values.intent) throw new Error('Usage: node scripts/make-fixture.ts --input good.jpg --id NAME --intent TEXT [--out fixtures]');
  const dir = await makeSyntheticFixture({ input: values.input, id: values.id, intent: values.intent, out: values.out!, longEdge: Number(values['long-edge']) });
  process.stdout.write(`Wrote ${SYNTHETIC_FAULTS.length} faults and fixture.json to ${dir}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
