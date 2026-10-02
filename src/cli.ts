import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileBridge } from './bridge.ts';
import { RunStore } from './store.ts';
import { PhotoController } from './controller.ts';
import { getPaths, preparePlugin } from './config.ts';
import { compareImages, detailCrop, verifyRestoredRendering } from './images.ts';
import { verifyMaskRoundtrip } from './mask-validation.ts';
import { mapRunDetails, parseDetailPoints } from './detail-map.ts';

const help = `Raw Photo Agent — local Lightroom Classic controller

node src/cli.ts setup                         Prepare the Lightroom plugin
node src/cli.ts status                        Connection and recent runs
node src/cli.ts capabilities                  Verified/implemented plugin features
node src/cli.ts selected                      Read selected photo identity
node src/cli.ts state --photo ID              Read settings without editing
node src/cli.ts selected-mask --photo ID      Read the selected mask and native slider ranges
node src/cli.ts select-mask --photo ID --mask ID Select an existing mask without changing its settings
node src/cli.ts start --photo ID --filename NAME --intent TEXT
node src/cli.ts history --run ID
node src/cli.ts edit --run ID --parent CANDIDATE --set '{"Exposure2012":0.25}' --reason TEXT
node src/cli.ts edit-mask --run ID --parent CANDIDATE --mask MASK_ID --set '{"local_Exposure":0.2}' --reason TEXT [--direction TEXT]
node src/cli.ts capture --run ID --reason TEXT [--parent CANDIDATE]
node src/cli.ts restore --run ID --candidate ID
node src/cli.ts render --run ID --candidate ID [--size 2048] [--format JPEG|TIFF]
node src/cli.ts compare --run ID --candidates ID,ID[,ID] --question TEXT
node src/cli.ts choose --choice ID --candidate ID [--feedback TEXT]
node src/cli.ts reconcile --run ID --candidate ID
node src/cli.ts recover --run ID --candidate ID Restore an interrupted run; verify before resume
node src/cli.ts resume-start --run ID --photo ID --filename NAME
node src/cli.ts verify-roundtrip --run ID --candidate ID
node src/cli.ts verify-mask-roundtrip --run ID --candidate ID --mask MASK_ID [--format JPEG|TIFF]
node src/cli.ts image-diff --before PATH --after PATH
node src/cli.ts crop --input PATH --output PATH --region '{"left":0,"top":0,"width":512,"height":512}'
node src/cli.ts detail-map --run ID --candidates ID,ID[,ID] --anchor ID --points '[{"id":"eye","label":"Eye","x":0.5,"y":0.4}]' --output DIR
                                              Crop the same scene region from differently cropped candidates' recorded exports

Commands emit JSON. No model API key is needed: the current agent drives this controller.
Start requires the filename explicitly chosen by the user; it creates a virtual copy.
All edits and restoration are restricted by the plugin to selected virtual copies.
`;

const valueOptions = ['photo','filename','intent','run','parent','mask','set','reason','candidate','size','format','candidates','question','choice','feedback','before','after','input','output','region','direction','anchor','points'] as const;
const { values, positionals } = parseArgs({ options: Object.fromEntries(valueOptions.map(name => [name, { type: 'string' as const }])), allowPositionals: true });
const command = positionals[0] ?? 'help';
const required = (name: string) => {
  const value = values[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
};
function objectArgument(name: string): Record<string, unknown> {
  const input = required(name);
  const result: unknown = JSON.parse(input.startsWith('@') ? readFileSync(input.slice(1), 'utf8') : input);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`--${name} must be a JSON object.`);
  return result as Record<string, unknown>;
}
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main() {
  if (command === 'help') { process.stdout.write(help); return; }
  if (command === 'setup') {
    const paths = preparePlugin();
    output({ pluginPath: paths.pluginInstall, bridgeDir: paths.bridgeDir, next: 'In Lightroom Classic: File > Plug-in Manager > Add, then select pluginPath. Start Raw Photo Agent Bridge if it is not running.' });
    return;
  }
  if (command === 'image-diff') { output(await compareImages(required('before'), required('after'))); return; }
  if (command === 'crop') {
    if (existsSync(required('output'))) throw new Error('Crop output already exists. Choose a fresh path.');
    output(await detailCrop(required('input'), required('output'), objectArgument('region') as { left: number; top: number; width: number; height: number })); return;
  }
  const paths = getPaths();
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const bridge = new FileBridge(paths.bridgeDir, { timeoutMs: 60000 });
  const store = new RunStore(paths.database);
  const controller = new PhotoController(bridge, store, paths.exportRoot);
  // Hold one lock across the entire command, including multiple SDK calls.
  const changesSession = !['status','capabilities','selected','state','selected-mask','history','detail-map'].includes(command);
  const lockPath = join(paths.runtime, 'session.lock');
  let lock: number | undefined;
  let preserveLock = false;
  try {
    if (changesSession) {
      try { lock = openSync(lockPath, 'wx', 0o600); }
      catch { throw new Error('Another editing command owns session.lock. If a prior process crashed, inspect its PID and the Lightroom state before removing the stale lock.'); }
      writeFileSync(lock, JSON.stringify({ pid: process.pid, command, createdAt: new Date().toISOString() }));
    }
    switch (command) {
      case 'status': output({ connection: await bridge.status(), runs: store.listRuns() }); break;
      case 'capabilities': output(await bridge.call('capabilities')); break;
      case 'selected': output(await controller.selected()); break;
      case 'state': output(await controller.state(required('photo'))); break;
      case 'selected-mask': output(await bridge.call('selected_mask', { photoId: required('photo') })); break;
      case 'select-mask': {
        const photoId = required('photo'); const maskId = required('mask');
        const state = await controller.state(photoId);
        output(await bridge.call('select_mask', { photoId, expectedStateToken: state.stateToken, maskId })); break;
      }
      case 'start': output(await controller.start(required('photo'), required('intent'), required('filename'))); break;
      case 'history': {
        const runId = required('run');
        output({ run: controller.run(runId), candidates: store.listCandidates(runId), choices: store.listChoices(runId), events: store.listEvents(runId) }); break;
      }
      case 'edit': output(await controller.edit(required('run'), required('parent'), objectArgument('set'), required('reason'), values.direction as string | undefined)); break;
      case 'edit-mask': output(await controller.editMask(required('run'), required('parent'), required('mask'), objectArgument('set'), required('reason'), values.direction as string | undefined)); break;
      case 'capture': {
        const candidate = await controller.checkpoint(required('run'), required('reason'), values.parent as string | undefined, values.direction as string | undefined);
        output(await controller.render(required('run'), candidate.id)); break;
      }
      case 'restore': output(await controller.restore(required('run'), required('candidate'))); break;
      case 'render': output(await controller.render(required('run'), required('candidate'), Number(values.size ?? '2048'), (values.format ?? 'JPEG') as 'JPEG' | 'TIFF')); break;
      case 'detail-map': output(await mapRunDetails(store, required('run'), required('candidates').split(','), required('anchor'),
        parseDetailPoints(required('points').startsWith('@') ? readFileSync(required('points').slice(1), 'utf8') : required('points')), required('output'))); break;
      case 'compare': output(controller.compare(required('run'), required('candidates').split(','), required('question'))); break;
      case 'choose': output(await controller.choose(required('choice'), required('candidate'), values.feedback as string | undefined)); break;
      case 'reconcile': output(await controller.reconcile(required('run'), required('candidate'))); break;
      case 'resume-start': output(await controller.resumeStart(required('run'), required('photo'), required('filename'))); break;
      case 'verify-mask-roundtrip': {
        const report = await verifyMaskRoundtrip(controller, required('run'), required('candidate'), required('mask'), (values.format ?? 'JPEG') as 'JPEG' | 'TIFF');
        output(report);
        if (!report.passed) process.exitCode = 2;
        break;
      }
      case 'recover': {
        const run = controller.run(required('run'));
        if (run.status !== 'interrupted') throw new Error('recover is only for interrupted runs. Use restore otherwise.');
        output({ state: await controller.restore(run.id, required('candidate'), true), next: 'Inspect the image, then reconcile with this candidate to resume.' }); break;
      }
      case 'verify-roundtrip': {
        const runId = required('run'); const candidateId = required('candidate');
        const run = controller.run(runId);
        const baseline = controller.candidate(runId, candidateId);
        const state = await controller.state(run.workingPhotoId);
        if (state.stateToken !== baseline.stateToken) throw new Error('Restore the supplied baseline before this test.');
        try {
        const before = await controller.render(runId, candidateId);
        const current = Number(state.settings.Exposure2012 ?? 0);
        const value = current > 4.5 ? current - 0.25 : current + 0.25;
        const changed = await controller.edit(runId, candidateId, { Exposure2012: value }, 'Roundtrip exposure test');
        const changedState = await controller.state(run.workingPhotoId);
        const appliedValue = Number(changedState.settings.Exposure2012);
        const changedPixels = await compareImages(before.previewPath!, changed.previewPath!);
        await controller.restore(runId, candidateId);
        const restoration = await verifyRestoredRendering(before.previewPath!, () => controller.render(runId, candidateId));
        const after = restoration.preview;
        const difference = restoration.difference;
        const applied = Math.abs(appliedValue - value) < 0.00001 && changedState.stateToken !== state.stateToken;
        // A few differing JPEG channels do not prove that the deliberate 0.25 EV
        // probe reached the renderer. Require a visible numerical effect.
        const renderedChangeVerified = changedPixels.sameDimensions &&
          typeof changedPixels.meanAbsoluteDifference === 'number' && changedPixels.meanAbsoluteDifference > 0.1;
        const passed = applied && renderedChangeVerified && difference.pixelsIdentical;
        if (!passed) { store.setRunStatus(runId, 'interrupted'); process.exitCode = 2; }
        store.addEvent(runId, 'roundtrip_checked', {
          candidateId, changedCandidateId: changed.id, applied, renderedChangeVerified,
          changedPixels, difference, restorationAttempts: restoration.attempts, passed,
        });
        output({
          baseline: after, testCandidate: changed, applied, renderedChangeVerified,
          changedPixels, difference, restorationAttempts: restoration.attempts, passed,
          ...(!passed ? { next: `Inspect Lightroom and the recorded render attempts, then reconcile run ${runId} with candidate ${candidateId} only after resolving the failed validation.` } : {}),
        });
        } catch (error) {
          store.setRunStatus(runId, 'interrupted');
          store.addEvent(runId, 'roundtrip_interrupted', { candidateId, message: String(error),
            next: `Inspect Lightroom, recover candidate ${candidateId}, then reconcile run ${runId}.` });
          // Preserve the bridge's uncertainty flag so the shared lock survives.
          throw error;
        }
        break;
      }
      default: throw new Error(`Unknown command: ${command}. Run help.`);
    }
  } catch (error) {
    preserveLock = !!(error && typeof error === 'object' && 'outcomeUncertain' in error && error.outcomeUncertain);
    throw error;
  } finally {
    store.close();
    if (lock !== undefined) { closeSync(lock); if (!preserveLock) unlinkSync(lockPath); }
  }
}
main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'ERROR', message: error.message, outcomeUncertain: error.outcomeUncertain ?? false }, null, 2)}\n`);
  process.exitCode = 1;
});
