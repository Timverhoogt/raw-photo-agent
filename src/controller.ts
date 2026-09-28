import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from './store.ts';
import type { Run, Candidate } from './store.ts';

export interface BridgeClient { call<T = unknown>(operation: string, params?: Record<string, unknown>): Promise<T> }
export interface Photo { photoId: string; name: string; fileFormat: string; isVirtualCopy: boolean; path?: string; copyName?: string }
export interface PhotoState { photoId: string; settings: Record<string, unknown>; stateToken: string; masks?: unknown; masksAvailable?: boolean }

export class PhotoController {
  readonly bridge: BridgeClient;
  readonly store: RunStore;
  readonly exportRoot: string;
  constructor(bridge: BridgeClient, store: RunStore, exportRoot: string) {
    this.bridge = bridge; this.store = store; this.exportRoot = exportRoot;
    mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
  }
  async selected() { return this.bridge.call<{ count: number; photos: Photo[] }>('selected'); }
  async state(photoId: string) {
    const state = await this.bridge.call<PhotoState>('read_state', { photoId });
    if (String(state.photoId) !== String(photoId) || !state.stateToken) throw new Error('Lightroom returned an invalid or mismatched photo state.');
    return state;
  }
  run(id: string): Run {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }
  candidate(runId: string, id: string): Candidate {
    const candidate = this.store.getCandidate(id);
    if (!candidate || candidate.runId !== runId) throw new Error('Candidate does not belong to this run.');
    return candidate;
  }
  private requireActive(run: Run) {
    if (run.status !== 'active') throw new Error(`Run is ${run.status}. Resolve the pending choice or reconcile the state before editing.`);
  }
  private async logged<T>(runId: string, operation: string, params: Record<string, unknown>): Promise<T> {
    const operationId = randomUUID();
    this.store.addEvent(runId, 'operation_started', { operationId, operation, params });
    try {
      const result = await this.bridge.call<T>(operation, params);
      this.store.addEvent(runId, 'operation_completed', { operationId, operation, result });
      return result;
    } catch (error) {
      this.store.addEvent(runId, 'operation_failed', { operationId, operation, message: String(error) });
      this.store.setRunStatus(runId, 'interrupted');
      throw error;
    }
  }
  async start(expectedPhotoId: string, intent: string, expectedFilename: string) {
    if (!intent.trim() || !expectedFilename.trim()) throw new Error('An intention and the explicitly selected filename are required.');
    const selection = await this.selected();
    if (selection.count !== 1 || selection.photos.length !== 1) throw new Error('Select exactly one RAW in Lightroom Classic.');
    const source = selection.photos[0]!;
    if (String(source.photoId) !== String(expectedPhotoId) || source.name !== expectedFilename) throw new Error('The selected photo does not match the requested photo and filename.');
    if (!['RAW', 'DNG'].includes(source.fileFormat.toUpperCase())) throw new Error('The first version requires a RAW or DNG source.');
    const runId = randomUUID();
    const originalState = await this.state(source.photoId);
    this.store.createRun({ id: runId, sourcePhotoId: expectedPhotoId, workingPhotoId: `pending:${runId}`, intent });
    this.store.addEvent(runId, 'start_requested', { source, originalSettings: originalState.settings });
    const copy = await this.logged<{ photoId: string }>(runId, 'create_working_copy', {
      photoId: expectedPhotoId, copyName: `Raw Photo Agent ${runId.slice(0, 8)}`,
    });
    this.store.attachWorkingCopy(runId, String(copy.photoId));
    this.store.addEvent(runId, 'working_copy_created', { source, workingPhotoId: copy.photoId });
    const baseline = await this.checkpoint(runId, 'Baseline', undefined, 'baseline');
    this.store.setBaseline(runId, baseline.id);
    const preview = await this.render(runId, baseline.id);
    return { run: this.run(runId), baseline: preview };
  }
  async checkpoint(runId: string, description: string, parentId?: string, direction = 'natural') {
    const run = this.run(runId); this.requireActive(run);
    if (parentId) this.candidate(runId, parentId);
    const result = await this.logged<{ snapshotId: string; state: PhotoState }>(runId, 'checkpoint', {
      photoId: run.workingPhotoId, name: `RPA ${description} ${randomUUID().slice(0, 8)}`,
    });
    return this.store.addCandidate({
      runId, parentId, snapshotId: String(result.snapshotId), stateToken: result.state.stateToken,
      settings: result.state.settings, direction, description,
    });
  }
  async edit(runId: string, parentId: string, adjustments: Record<string, unknown>, description: string, direction?: string) {
    const run = this.run(runId); this.requireActive(run);
    const parent = this.candidate(runId, parentId);
    if (!description.trim() || Object.keys(adjustments).length === 0) throw new Error('Describe a purposeful edit and supply adjustments.');
    if (this.store.listCandidates(runId).length >= 13) throw new Error('The initial run limit is 12 editing candidates plus baseline. Review the retained candidates before starting another run.');
    const before = await this.state(run.workingPhotoId);
    if (before.stateToken !== parent.stateToken) throw new Error('The photo differs from the parent candidate. Restore that candidate or capture the intentional user edit first.');
    await this.logged(runId, 'apply', { photoId: run.workingPhotoId, expectedStateToken: before.stateToken, adjustments });
    const candidate = await this.checkpoint(runId, description, parentId, direction ?? parent.direction ?? 'natural');
    return this.render(runId, candidate.id);
  }
  async editMask(runId: string, parentId: string, maskId: string, adjustments: Record<string, unknown>, description: string, direction?: string) {
    const run = this.run(runId); this.requireActive(run);
    const parent = this.candidate(runId, parentId);
    if (typeof maskId !== 'string' || !maskId.trim()) throw new Error('An explicit mask ID is required.');
    if (!description.trim() || Object.keys(adjustments).length === 0) throw new Error('Describe a purposeful mask edit and supply adjustments.');
    if (this.store.listCandidates(runId).length >= 13) throw new Error('The initial run limit is 12 editing candidates plus baseline. Review the retained candidates before starting another run.');
    const before = await this.state(run.workingPhotoId);
    if (before.stateToken !== parent.stateToken) throw new Error('The photo differs from the parent candidate. Restore that candidate or capture the intentional user edit first.');
    await this.logged(runId, 'adjust_mask', {
      photoId: run.workingPhotoId, expectedStateToken: before.stateToken, maskId, adjustments,
    });
    const candidate = await this.checkpoint(runId, description, parentId, direction ?? parent.direction ?? 'natural');
    return this.render(runId, candidate.id);
  }
  async render(runId: string, candidateId: string, maxEdge = 2048) {
    const run = this.run(runId);
    const candidate = this.candidate(runId, candidateId);
    if (!Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > 8192) throw new Error('maxEdge must be an integer from 256 to 8192.');
    const outputPath = join(this.exportRoot, `${candidate.id}-${randomUUID()}.jpg`);
    const result = await this.logged<{ outputPath: string; photoId: string; stateToken: string }>(runId, 'render', {
      photoId: run.workingPhotoId, expectedStateToken: candidate.stateToken, outputPath, maxEdge,
    });
    if (result.outputPath !== outputPath || result.stateToken !== candidate.stateToken || !existsSync(outputPath) || statSync(outputPath).size === 0) {
      this.store.setRunStatus(runId, 'interrupted');
      throw new Error('The rendered image could not be verified for this candidate.');
    }
    // Keep the primary evidence immutable. Additional exports remain in the event journal.
    if (!candidate.previewPath) this.store.setCandidatePreview(candidateId, outputPath);
    return { ...this.candidate(runId, candidateId), previewPath: outputPath };
  }
  async restore(runId: string, candidateId: string, allowPaused = false) {
    const run = this.run(runId);
    if (!allowPaused) this.requireActive(run);
    const candidate = this.candidate(runId, candidateId);
    const before = await this.state(run.workingPhotoId);
    const result = await this.logged<{ state: PhotoState }>(runId, 'restore', {
      photoId: run.workingPhotoId, expectedStateToken: before.stateToken, snapshotId: candidate.snapshotId,
    });
    if (result.state.stateToken !== candidate.stateToken) {
      this.store.setRunStatus(runId, 'interrupted');
      this.store.addEvent(runId, 'restore_verification_failed', { candidateId, expected: candidate.stateToken, actual: result.state.stateToken });
      throw new Error('Snapshot was applied, but its state does not match the saved candidate. Run is interrupted.');
    }
    this.store.addEvent(runId, 'candidate_restored', { candidateId });
    return result.state;
  }
  compare(runId: string, candidateIds: string[], question: string) {
    const run = this.run(runId); this.requireActive(run);
    if (candidateIds.length < 2 || candidateIds.length > 3 || new Set(candidateIds).size !== candidateIds.length) throw new Error('Compare two or three distinct candidates.');
    const candidates = candidateIds.map(id => this.candidate(runId, id));
    if (candidates.some(c => !c.previewPath || !existsSync(c.previewPath))) throw new Error('Every candidate needs a verified preview before comparison.');
    const choice = this.store.createChoice({ runId, candidateIds, question });
    return { choice, candidates: candidates.map((candidate, index) => ({ label: String.fromCharCode(65 + index), ...candidate })) };
  }
  async choose(choiceId: string, candidateId: string, feedback?: string) {
    const choice = this.store.getChoice(choiceId);
    if (!choice || !choice.candidateIds.includes(candidateId)) throw new Error('Candidate is not a choice in this comparison.');
    if (choice.selectedCandidateId) return this.store.choose(choiceId, candidateId, feedback);
    if (this.run(choice.runId).status !== 'awaiting_choice') throw new Error('This run is not awaiting a choice. Reconcile an interruption before applying a decision.');
    this.store.addEvent(choice.runId, 'choice_requested', { choiceId, candidateId, feedback });
    try {
      await this.restore(choice.runId, candidateId, true);
      return this.store.choose(choiceId, candidateId, feedback);
    } catch (error) {
      this.store.setRunStatus(choice.runId, 'interrupted');
      throw error;
    }
  }
  async reconcile(runId: string, candidateId: string) {
    const run = this.run(runId);
    if (run.status !== 'interrupted') throw new Error('Only an interrupted run needs reconciliation.');
    const candidate = this.candidate(runId, candidateId);
    const state = await this.state(run.workingPhotoId);
    if (state.stateToken !== candidate.stateToken) throw new Error('Current state does not match this candidate. Inspect Lightroom, then use recover to restore a named checkpoint.');
    const pendingChoice = this.store.listChoices(runId).some(c => !c.selectedCandidateId);
    this.store.setRunStatus(runId, pendingChoice ? 'awaiting_choice' : 'active');
    this.store.addEvent(runId, 'reconciled', { candidateId, stateToken: state.stateToken });
    return this.run(runId);
  }
  async resumeStart(runId: string, expectedPhotoId: string, expectedFilename: string) {
    const run = this.run(runId);
    if (!['active', 'interrupted'].includes(run.status) || this.store.listCandidates(runId).length !== 0) throw new Error('resume-start is only for an incomplete initialization with no saved candidates.');
    const selection = await this.selected();
    const selected = selection.photos[0];
    if (selection.count !== 1 || !selected?.isVirtualCopy || selected.photoId !== expectedPhotoId || selected.name !== expectedFilename || selected.copyName !== `Raw Photo Agent ${runId.slice(0, 8)}`) {
      throw new Error('Select the exact working copy named for this run; provide its photo ID and filename.');
    }
    const start = this.store.listEvents(runId).find(event => event.type === 'start_requested')?.payload as { source?: Photo; originalSettings?: unknown } | undefined;
    if (!start?.source || start.source.path !== selected.path) throw new Error('The selected copy does not match the recorded source.');
    const state = await this.state(expectedPhotoId);
    const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    if (canonical(state.settings) !== canonical(start.originalSettings)) throw new Error('This copy has changed since initialization. Inspect it manually; do not accept it as the original baseline.');
    this.store.attachWorkingCopy(runId, expectedPhotoId);
    this.store.setRunStatus(runId, 'active');
    const baseline = await this.checkpoint(runId, 'Recovered baseline', undefined, 'baseline');
    this.store.setBaseline(runId, baseline.id);
    return { run: this.run(runId), baseline: await this.render(runId, baseline.id) };
  }
}
