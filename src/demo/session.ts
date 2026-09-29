import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Photo, PhotoController } from '../controller.ts';
import type { Candidate } from '../store.ts';
import { verifyRestoredRendering } from '../images.ts';
import type { Decision, DecisionInput } from '../agent/core.ts';

export type DemoStatus = 'preparing' | 'running' | 'pausing' | 'paused' | 'awaiting_answer' | 'awaiting_choice' | 'completed' | 'error';
export interface DemoEvent { id: string; at: string; type: string; title: string; text: string; changes?: Record<string, number> }
export interface DemoCandidate { id: string; label: string; description: string; url: string; changes?: Record<string, number> }
export interface DemoSession {
  id: string; name: string; status: DemoStatus; intent: string; stage: string; startedAt: string;
  runId?: string; currentCandidateId?: string; selectedCandidateId?: string; exportUrl?: string;
  candidates: DemoCandidate[]; events: DemoEvent[];
  question?: { id: string; text: string; options: string[] };
  comparison?: { choiceId: string; question: string; candidateIds: string[] };
  error?: string;
}
export interface PhotoAgent { decide(input: DecisionInput, signal?: AbortSignal): Promise<Decision> }
export interface Upload { id: string; name: string; size: number; path: string }

/** One live demo owns the same session lock as the CLI, including review pauses. */
export class DemoEngine extends EventEmitter {
  session: DemoSession | null = null;
  readonly controller: PhotoController;
  readonly agent: PhotoAgent;
  readonly runtime: string;
  private lock: number | undefined;
  private lockOwner = randomUUID();
  private task: Promise<void> | undefined;
  private modelAbort: AbortController | undefined;
  private pauseRequested = false;
  private stopRequested = false;
  private feedback: string[] = [];
  private decisions = 0;
  private edits = 0;
  private questions = 0;
  private finalizing = false;
  private finalPath: string | undefined;
  private readonly maxEdits: number;
  constructor(controller: PhotoController, agent: PhotoAgent, runtime: string, options: { maxEdits?: number; load?: boolean } = {}) {
    super(); this.controller = controller; this.agent = agent; this.runtime = runtime;
    this.maxEdits = options.maxEdits ?? 6;
    mkdirSync(join(runtime, 'demo'), { recursive: true, mode: 0o700 });
    if (options.load !== false && existsSync(this.statePath())) {
      const saved = JSON.parse(readFileSync(this.statePath(), 'utf8')) as { session: DemoSession; finalPath?: string };
      this.session = saved.session; this.finalPath = saved.finalPath;
      if (!['completed', 'error'].includes(this.session.status)) {
        this.session.status = 'error'; this.session.stage = 'Session interrupted';
        this.session.error = 'The demo server stopped during a session. Inspect Lightroom and reconcile the run with the CLI before removing its stale session lock. This session will not resume automatically.';
        if (this.session.runId) this.controller.store.setRunStatus(this.session.runId, 'interrupted');
        this.persist();
      }
    }
  }
  private statePath() { return join(this.runtime, 'demo', 'session.json'); }
  private persist() {
    const path = this.statePath(); const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ session: this.session, finalPath: this.finalPath }, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  }
  private update() { this.persist(); this.emit('change'); }
  private note(type: string, title: string, text: string, changes?: Record<string, number>) {
    this.session!.events.push({ id: randomUUID(), at: new Date().toISOString(), type, title, text, ...(changes ? { changes } : {}) });
    this.update();
  }
  private stage(value: string) { this.session!.stage = value; this.update(); }
  private acquire() {
    try { this.lock = openSync(join(this.runtime, 'session.lock'), 'wx', 0o600); }
    catch { throw new Error('Another editing session owns Lightroom. Finish that session, or inspect a stale session.lock before starting.'); }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, command: 'demo', owner: this.lockOwner, createdAt: new Date().toISOString() }));
  }
  private release(preserveLock = false) {
    if (this.lock === undefined) return;
    closeSync(this.lock); this.lock = undefined;
    if (preserveLock) return;
    const path = join(this.runtime, 'session.lock');
    try { if (JSON.parse(readFileSync(path, 'utf8')).owner === this.lockOwner) unlinkSync(path); } catch { /* Preserve externally replaced or damaged locks. */ }
  }
  private fail(error: unknown) {
    if (!this.session) return;
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = !!(error && typeof error === 'object' && 'outcomeUncertain' in error && error.outcomeUncertain);
    this.session.status = 'error'; this.session.error = message; this.session.stage = 'Needs attention';
    if (this.session.runId) this.controller.store.setRunStatus(this.session.runId, 'interrupted');
    this.note('error', 'Session stopped', `${message} No uncertain Lightroom operation was retried.${uncertain ? ' The session lock is retained: inspect the pending Lightroom operation before starting another session.' : ''}`);
    this.release(uncertain);
  }
  private launch(work: () => Promise<void>) {
    const pending = (this.task ?? Promise.resolve()).then(work).catch(error => this.fail(error)).finally(() => { if (this.task === pending) this.task = undefined; });
    this.task = pending;
  }
  async idle() { await this.task; }
  start(input: { intent: string; upload?: Upload; useSelected?: boolean }) {
    if (this.task || (this.session && !['completed','error'].includes(this.session.status))) throw new Error('Finish the current session before adding another photo.');
    if (!input.intent.trim() || input.intent.length > 2000) throw new Error('Provide an editing intention of 1–2000 characters.');
    if ((!input.upload && !input.useSelected) || (input.upload && input.useSelected)) throw new Error('Choose one uploaded RAW or the selected Lightroom photo.');
    this.acquire();
    this.pauseRequested = false; this.stopRequested = false; this.feedback = []; this.decisions = 0; this.edits = 0; this.questions = 0; this.finalizing = false; this.finalPath = undefined;
    this.session = { id: randomUUID(), name: input.upload?.name ?? 'Selected Lightroom photo', status: 'preparing', intent: input.intent.trim(), stage: 'Preparing Lightroom', startedAt: new Date().toISOString(), candidates: [], events: [] };
    this.note('status', 'Session started', 'Preparing a working copy and a baseline preview.');
    this.launch(async () => {
      let photo: Photo;
      if (input.upload) {
        this.stage('Importing RAW');
        photo = await this.controller.bridge.call<Photo>('import_photo', { path: input.upload.path, filename: input.upload.name });
        if (photo.name !== input.upload.name) throw new Error('Lightroom imported a different filename than the selected upload.');
      } else {
        const selection = await this.controller.selected();
        if (selection.count !== 1 || selection.photos.length !== 1) throw new Error('Select exactly one RAW in Lightroom, then start again.');
        photo = selection.photos[0]!;
        await this.controller.bridge.call('reveal_photo', { photoId: photo.photoId });
      }
      this.session!.name = photo.name;
      this.stage('Creating a virtual copy');
      const result = await this.controller.start(photo.photoId, input.intent, photo.name);
      this.session!.runId = result.run.id;
      this.addCandidate(result.baseline);
      this.note('checkpoint', 'Baseline saved', 'The original edit is preserved. This preview comes from the new Lightroom virtual copy.');
      this.session!.status = 'running'; this.update();
      await this.loop();
    });
    return this.session;
  }
  private addCandidate(candidate: Candidate, changes?: Record<string, number>) {
    if (!candidate.previewPath) throw new Error('The candidate has no verified preview.');
    const session = this.session!;
    if (!session.candidates.some(c => c.id === candidate.id)) session.candidates.push({ id: candidate.id, label: session.candidates.length === 0 ? 'Original' : `Edit ${session.candidates.length}`, description: candidate.description ?? 'Checkpoint', url: `/api/previews/${session.id}/${candidate.id}`, ...(changes ? { changes } : {}) });
    session.currentCandidateId = candidate.id; this.update();
  }
  private candidates() { return this.controller.store.listCandidates(this.session!.runId!); }
  private decisionCandidates() {
    const all = this.candidates();
    const current = all.find(candidate => candidate.id === this.session!.currentCandidateId);
    const parent = all.find(candidate => candidate.id === current?.parentId);
    // The vision provider attaches current first, then the first two references.
    // Keep the baseline and the current edit's parent visible on later rounds.
    return [...new Set([all[0], parent, ...all.slice().reverse()].filter((candidate): candidate is Candidate => !!candidate))];
  }
  private async boundary() {
    if (this.stopRequested) { await this.finish(); return true; }
    if (this.pauseRequested) {
      this.session!.status = 'paused'; this.stage('Paused');
      this.note('status', 'Paused at a checkpoint', 'Resume when you are ready. No new edit will start while paused.');
      return true;
    }
    return false;
  }
  private async loop() {
    while (true) {
      if (await this.boundary()) return;
      if (this.decisions >= 12) { this.note('status', 'Review time', 'The bounded demo session has reached its decision limit. Compare the retained versions.'); await this.finish(); return; }
      this.session!.status = 'running'; this.stage('Inspecting the photograph');
      this.modelAbort = new AbortController();
      let decision: Decision;
      try {
        decision = await this.agent.decide({
          intent: this.session!.intent, currentCandidateId: this.session!.currentCandidateId!,
          candidates: this.decisionCandidates().filter(c => c.previewPath).map(c => ({ id: c.id, description: c.description ?? '', previewPath: c.previewPath!, settings: (c.settings ?? {}) as Record<string, unknown> })),
          history: this.session!.events.filter(e => ['observation','adjustment','restore'].includes(e.type)).map(e => ({ title: e.title, text: e.text })),
          feedback: this.feedback, remainingEdits: Math.max(0, this.maxEdits - this.edits),
        }, this.modelAbort.signal);
      } catch (error) {
        if ((this.pauseRequested || this.stopRequested) && this.modelAbort.signal.aborted) { if (await this.boundary()) return; }
        throw error;
      } finally { this.modelAbort = undefined; }
      if (await this.boundary()) return;
      this.decisions++;
      this.note('observation', decision.title, decision.observation);
      if (decision.action === 'ask') {
        if (++this.questions > 2) { await this.finish(); return; }
        if (!decision.question || decision.options.length < 2 || decision.options.length > 3) throw new Error('The agent returned an invalid comparison question.');
        this.session!.question = { id: randomUUID(), text: decision.question, options: decision.options };
        this.session!.status = 'awaiting_answer'; this.stage('Your direction');
        this.note('question', 'A creative decision', decision.reason);
        return;
      }
      if (decision.action === 'finish') {
        if (decision.candidateId && decision.candidateId !== this.session!.currentCandidateId) await this.restore(decision.candidateId, decision.reason);
        this.note('status', 'Ready to compare', decision.reason); await this.finish(); return;
      }
      if (decision.action === 'restore') {
        if (!decision.candidateId) throw new Error('The agent did not identify a checkpoint to restore.');
        await this.restore(decision.candidateId, decision.reason);
      } else if (decision.action === 'edit') {
        if (this.edits >= this.maxEdits) { this.note('status', 'Edit limit reached', 'The agent has inspected the final preview. Compare the retained versions.'); await this.finish(); return; }
        this.stage('Adjusting Lightroom');
        this.note('adjustment', decision.title, decision.reason, decision.adjustments);
        const candidate = await this.controller.edit(this.session!.runId!, this.session!.currentCandidateId!, decision.adjustments, decision.title);
        this.edits++; this.addCandidate(candidate, decision.adjustments);
        this.note('checkpoint', 'Preview rendered', 'Lightroom returned a fresh preview tied to this checkpoint. The agent will inspect it before making another decision.');
      } else throw new Error('Unsupported agent decision.');
    }
  }
  private async verifyRestoration(candidate: Candidate) {
    if (!candidate.previewPath) throw new Error('The saved checkpoint has no reference preview.');
    const result = await verifyRestoredRendering(candidate.previewPath, async () => {
      const render = await this.controller.render(this.session!.runId!, candidate.id);
      return { ...render, previewPath: render.previewPath! };
    });
    this.controller.store.addEvent(this.session!.runId!, 'demo_restoration_checked', { candidateId: candidate.id, attempts: result.attempts, passed: result.difference.pixelsIdentical });
    if (!result.difference.pixelsIdentical) throw new Error('The snapshot settings were restored, but its rendered pixels still differ from the saved preview. Inspect Lightroom before continuing.');
  }
  private async restore(candidateId: string, reason: string) {
    const candidate = this.controller.candidate(this.session!.runId!, candidateId);
    this.stage('Returning to a checkpoint');
    this.note('restore', 'Revisiting an earlier edit', reason);
    await this.controller.restore(this.session!.runId!, candidateId);
    await this.verifyRestoration(candidate);
    this.session!.currentCandidateId = candidateId; this.update();
    this.note('checkpoint', 'Checkpoint verified', 'The saved settings and rendered pixels match the earlier preview.');
  }
  private async finish() {
    const session = this.session!;
    delete session.question;
    const all = this.candidates();
    if (!all.length) throw new Error('No baseline was completed.');
    // Include the original, the agent's retained state, and at most one alternative.
    const ids = [...new Set([all[0]!.id, session.currentCandidateId!, all.at(-1)!.id])];
    if (ids.length === 1 && all.length > 1) ids.push(all[all.length - 2]!.id);
    if (ids.length === 1) {
      this.finalizing = true;
      this.stage('Exporting the retained original');
      const final = await this.controller.render(session.runId!, ids[0]!, 8192);
      this.finalPath = final.previewPath!;
      session.exportUrl = `/api/previews/${session.id}/final`;
      this.controller.store.setRunStatus(session.runId!, 'completed');
      session.selectedCandidateId = ids[0]; session.status = 'completed'; session.stage = 'Original retained';
      this.note('complete', 'No edit needed', 'The session retained the original rendering.'); this.release(); return;
    }
    const comparison = this.controller.compare(session.runId!, ids, 'Which version would you keep?');
    session.comparison = { choiceId: comparison.choice.id, question: comparison.choice.question, candidateIds: ids };
    session.status = 'awaiting_choice'; this.stage('Choose a final version');
    this.note('comparison', 'Your final choice', 'Compare the original and retained edits. Your selection will be active in Lightroom and exported as an sRGB JPEG, up to 8192 pixels on its long edge.');
  }
  requireSession(id: string) { if (!this.session || this.session.id !== id) throw new Error('This session is no longer current.'); return this.session; }
  pause(id: string) {
    const s = this.requireSession(id);
    if (this.finalizing) throw new Error('The final JPEG is being prepared. Let this export finish.');
    if (!['running','preparing','pausing'].includes(s.status)) throw new Error('This session is not currently running.');
    this.pauseRequested = true; s.status = 'pausing'; this.stage('Pausing at the next safe point'); this.modelAbort?.abort();
  }
  resume(id: string) {
    const s = this.requireSession(id);
    if (s.status !== 'paused') throw new Error('Only a paused session can resume.');
    this.pauseRequested = false; s.status = 'running'; this.update(); this.launch(() => this.loop());
  }
  answer(id: string, questionId: string, answer: string) {
    const s = this.requireSession(id);
    if (s.status !== 'awaiting_answer' || s.question?.id !== questionId) throw new Error('This question is no longer awaiting an answer.');
    if (!answer.trim() || answer.length > 2000) throw new Error('Provide an answer of 1–2000 characters.');
    this.feedback.push(`${s.question.text}: ${answer.trim()}`);
    this.note('feedback', 'Your direction', answer.trim()); delete s.question;
    s.status = 'running'; this.update(); this.launch(() => this.loop());
  }
  stop(id: string) {
    const s = this.requireSession(id);
    if (this.finalizing) throw new Error('The final JPEG is being prepared. Let this export finish.');
    if (['completed','error','awaiting_choice'].includes(s.status)) throw new Error('This session has already stopped editing.');
    this.stopRequested = true; this.pauseRequested = false; this.modelAbort?.abort();
    s.status = 'pausing'; this.stage('Finishing at the next checkpoint');
    if (!this.task) this.launch(() => this.finish());
  }
  choose(id: string, candidateId: string) {
    const s = this.requireSession(id);
    if (s.status !== 'awaiting_choice' || !s.comparison?.candidateIds.includes(candidateId)) throw new Error('Choose one of the presented versions.');
    const choiceId = s.comparison.choiceId;
    this.finalizing = true;
    s.status = 'running'; this.stage('Preparing your selection');
    this.launch(async () => {
      const candidate = this.controller.candidate(s.runId!, candidateId);
      const current = await this.controller.state(this.controller.run(s.runId!).workingPhotoId);
      if (current.stateToken === candidate.stateToken) {
        this.controller.store.addEvent(s.runId!, 'choice_requested', { choiceId, candidateId, feedback: 'Selected in the live demo', alreadyCurrent: true });
        this.controller.store.choose(choiceId, candidateId, 'Selected in the live demo');
      } else {
        await this.controller.choose(choiceId, candidateId, 'Selected in the live demo');
        await this.verifyRestoration(candidate);
      }
      this.stage('Exporting your selection');
      const final = await this.controller.render(s.runId!, candidateId, 8192);
      this.finalPath = final.previewPath!;
      s.currentCandidateId = candidateId; s.selectedCandidateId = candidateId;
      s.exportUrl = `/api/previews/${s.id}/final`;
      this.controller.store.setRunStatus(s.runId!, 'completed');
      s.status = 'completed'; s.stage = 'Finished';
      this.note('complete', 'Your photograph is ready', 'Your chosen edit is active in Lightroom. An sRGB JPEG (up to 8192 pixels on its long edge) has been exported locally.');
      this.release();
    });
  }
  preview(sessionId: string, candidateId: string) {
    const s = this.requireSession(sessionId);
    if (candidateId === 'final' && s.status === 'completed' && this.finalPath) return this.finalPath;
    if (!s.candidates.some(c => c.id === candidateId)) throw new Error('Preview not found.');
    const path = this.controller.candidate(s.runId!, candidateId).previewPath;
    if (!path) throw new Error('Preview not found.');
    return path;
  }
  async shutdown() {
    if (!this.session || ['completed','error'].includes(this.session.status)) return;
    this.pauseRequested = true; this.modelAbort?.abort(); await this.idle();
    this.fail(new Error('Demo server stopped. Inspect the saved checkpoint before resuming with the CLI.'));
  }
}
