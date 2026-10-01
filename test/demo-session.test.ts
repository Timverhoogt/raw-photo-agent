import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { RunStore } from '../src/store.ts';
import { PhotoController } from '../src/controller.ts';
import { DemoEngine } from '../src/demo/session.ts';
import { PhotoAgentError } from '../src/agent/core.ts';
import type { Decision } from '../src/agent/core.ts';

function decision(overrides: Partial<Decision> = {}): Decision { return {action:'finish',title:'Ready',observation:'The visible detail is retained.',reason:'Compare the versions.',adjustments:{},candidateId:null,maskId:null,question:null,options:[],detailPoints:[],...overrides}; }
function fixture(agent: {decide: (...args:any[])=>Promise<Decision>}, options: {failApply?:boolean; failExport?:boolean; mismatchedExport?:boolean; maxEdits?:number; existingMask?: boolean; localEdits?: boolean; maskReadbackMismatch?: boolean; failMaskApply?: boolean} = {}) {
  const root = mkdtempSync(join(tmpdir(),'rpa-demo-test-')); const store = new RunStore(join(root,'test.sqlite'));
  const snapshots = new Map<string,{ settings: { Exposure2012: number }; local: { local_Exposure: number; local_Texture: number } }>(); let settings = {Exposure2012:0}; let selected='source'; let applications=0; let restorations=0;
  let local = { local_Exposure: 0, local_Texture: 0 }; let selectedMask = 'subject-mask'; let localApplications = 0; let maskReads = 0; let exposureMaximum = 4;
  const original = {...settings};
  const renders: Array<{ path: string; maxEdge: number; exposure: number }> = [];
  const state = () => {
    const currentSettings = {...settings, ...(options.existingMask ? { MaskGroupBasedCorrections: [{ CorrectionID: 'subject-mask', CorrectionName: 'Mask 1', CorrectionActive: true,
      CorrectionMasks: [{ MaskName: 'Subject 1' }], LocalExposure2012: local.local_Exposure / 4, LocalTexture: local.local_Texture / 100 }] } : {})};
    return {photoId:selected,settings:currentSettings,stateToken:JSON.stringify({selected,settings:currentSettings})};
  };
  const bridge = {async call<T>(operation:string,params:Record<string,unknown> = {}):Promise<T> {
    let result:unknown;
    if(operation==='selected') result={count:1,photos:[{photoId:selected,name:'sample.cr3',fileFormat:'RAW',isVirtualCopy:selected==='copy'}]};
    else if(operation==='reveal_photo') result={};
    else if(operation==='read_state') result=state();
    else if(operation==='create_working_copy') {selected='copy';result={photoId:selected};}
    else if(operation==='checkpoint') {const id=`snapshot-${snapshots.size}`;snapshots.set(id,{ settings:{...settings}, local:{...local} });result={snapshotId:id,state:state()};}
    else if(operation==='apply') {applications++;if(options.failApply)throw Object.assign(new Error('uncertain render response'),{outcomeUncertain:true});settings={...settings,...params.adjustments as object};result={state:state()};}
    else if(operation==='restore') {restorations++;const snapshot=snapshots.get(String(params.snapshotId))!;settings={...snapshot.settings};local={...snapshot.local};result={state:state()};}
    else if(operation==='select_mask' || operation==='selected_mask') {
      maskReads++;
      if(operation==='select_mask') { assert.equal(params.expectedStateToken,state().stateToken); selectedMask=String(params.maskId); }
      if(params.maskId!==selectedMask) throw new Error('The selected mask changed during review.');
      result={state:state(),maskContext:{selectedMaskId:options.maskReadbackMismatch?'different-mask':selectedMask,parameters:{
        local_Exposure:{value:local.local_Exposure,min:-4,max:exposureMaximum},local_Texture:{value:local.local_Texture,min:-100,max:100},
      }}};
    }
    else if(operation==='adjust_mask') {
      localApplications++; assert.equal(params.maskId,'subject-mask'); assert.equal(params.expectedStateToken,state().stateToken);
      if(options.failMaskApply) throw Object.assign(new Error('Uncertain native mask write'),{outcomeUncertain:true});
      local={...local,...params.adjustments as object};result={state:state()};
    }
    else if(operation==='render') {
      if (params.maxEdge === 8192 && options.failExport) throw new PhotoAgentError('TIMEOUT', 'Native export timed out');
      const value=Math.max(0,Math.min(255,100+Math.round(settings.Exposure2012*40+local.local_Exposure*30)));
      const width = params.maxEdge === 8192 ? options.mismatchedExport && applications ? 200 : 240 : 24;
      const height = params.maxEdge === 8192 ? 160 : 16;
      renders.push({ path: String(params.outputPath), maxEdge: Number(params.maxEdge), exposure: settings.Exposure2012 });
      await sharp({create:{width,height,channels:3,background:{r:value,g:value,b:value}}}).jpeg().toFile(String(params.outputPath));
      result={outputPath:params.outputPath,photoId:selected,stateToken:state().stateToken};
    } else throw new Error(`unexpected operation ${operation}`);
    return result as T;
  }};
  const controller = new PhotoController(bridge,store,join(root,'renders'));
  const engine = new DemoEngine(controller,{async decide(input,signal){const result=await agent.decide(input,signal);return {...result,candidateId:result.action==='ask'?null:result.candidateId??input.currentCandidateId};}},root,{load:false,maxEdits:options.maxEdits,
    ...(options.localEdits?{localEdits:{verified:true,existingMask:{maskId:'subject-mask'}}}:{}),
  });
  return {root,store,controller,engine,renders,get applications(){return applications},get restorations(){return restorations},get settings(){return settings},get local(){return local},get localApplications(){return localApplications},get maskReads(){return maskReads},manualMaskSelection(id:string){selectedMask=id;},changeMaskRange(max:number){exposureMaximum=max;},manualEdit(values:Record<string,number>){settings={...settings,...values};},original,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('demo edits a copy, presents actual candidates, restores user choice and exports it', async()=>{
  let calls=0;
  const f=fixture({async decide(input){calls++;assert.ok(input.candidates[0].previewPath);return calls===1?decision({action:'edit',title:'Lift subject',adjustments:{Exposure2012:0.25}}):decision();}});
  try{
    const s=f.engine.start({useSelected:true,intent:'Natural detail'}); await f.engine.idle();
    assert.equal(s.status,'awaiting_choice');assert.equal(s.candidates.length,2);assert.equal(f.applications,1);
    assert.equal(s.events.filter(e=>e.type==='adjustment').length,1);assert.deepEqual(f.original,{Exposure2012:0});
    assert.ok(existsSync(join(f.root,'session.lock')));
    f.engine.choose(s.id,s.candidates[0]!.id); await f.engine.idle();
    assert.equal(s.status,'completed');assert.equal(f.settings.Exposure2012,0);assert.ok(s.exportUrl);
    assert.ok(existsSync(f.engine.preview(s.id,'final')));assert.equal(existsSync(join(f.root,'session.lock')),false);
    assert.throws(()=>f.engine.preview('different-session',s.candidates[0]!.id));
    assert.throws(()=>f.engine.preview(s.id,'../../secret'));
  }finally{f.close();}
});

test('verified existing-mask loop inspects, edits native controls, compares and restores without changing global exposure', async () => {
  let calls = 0;
  const f = fixture({ async decide(input) {
    calls++;
    assert.equal(input.masks[0].maskId, 'subject-mask');
    assert.equal(input.masks[0].candidateId, input.currentCandidateId);
    assert.equal(input.masks[0].stateToken, input.currentStateToken);
    assert.deepEqual(input.masks[0].componentLabels, ['Subject 1']);
    if (calls === 1) return decision({ action: 'inspect', detailPoints: [{ id: 'subject-edge', label: 'Subject edge and nearby background', x: 0.5, y: 0.5 }] });
    if (calls === 2) return decision({ action: 'local-edit', maskId: 'subject-mask', adjustments: { local_Exposure: 0.25, local_Texture: 8 }, title: 'Lift subject gently' });
    if (calls === 3) {
      assert.equal(input.masks[0].parameters.local_Exposure.value, 0.25);
      assert.equal(input.masks[0].parameters.local_Texture.value, 8);
      assert.ok(input.candidates.every((candidate: { details: unknown[] }) => candidate.details.length === 1));
      return decision({ action: 'restore', candidateId: input.candidates[0].id, reason: 'The change made the visible edge too prominent.' });
    }
    return decision();
  } }, { existingMask: true, localEdits: true });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural subject with gentle separation' }); await f.engine.idle();
    assert.equal(session.status, 'awaiting_choice'); assert.equal(calls, 4);
    assert.equal(f.applications, 0); assert.equal(f.localApplications, 1); assert.equal(f.restorations, 1);
    assert.equal(f.settings.Exposure2012, 0); assert.deepEqual(f.local, { local_Exposure: 0, local_Texture: 0 });
    assert.deepEqual(session.candidates[1].mask, { id: 'subject-mask', label: 'Mask 1' });
    assert.deepEqual(session.candidates[1].changes, { local_Exposure: 0.25, local_Texture: 8 });
    const event = session.events.find(event => event.type === 'local-adjustment')!;
    assert.equal(event.mask!.id, 'subject-mask'); assert.match(event.text, /Existing mask “Mask 1”/);
    assert.match(session.candidates[1].description, /Mask 1/);
    const saved = JSON.parse(readFileSync(join(f.root, 'demo', 'session.json'), 'utf8'));
    assert.deepEqual(saved.session.candidates[1].mask, session.candidates[1].mask);
  } finally { f.close(); }
});

test('existing masks remain unavailable until local edits are explicitly enabled', async () => {
  const f = fixture({ async decide(input) {
    assert.equal(input.masks, undefined);
    return decision({ action: 'local-edit', maskId: 'subject-mask', adjustments: { local_Exposure: 0.2 } });
  } }, { existingMask: true });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.status, 'error'); assert.match(session.error!, /verified existing mask/);
    assert.equal(f.maskReads, 0); assert.equal(f.localApplications, 0); assert.equal(f.applications, 0);
  } finally { f.close(); }
});

test('missing or mismatched mask identity stops preparation before model review or editing', async () => {
  for (const options of [{ localEdits: true }, { localEdits: true, existingMask: true, maskReadbackMismatch: true }]) {
    let reviews = 0;
    const f = fixture({ async decide() { reviews++; return decision(); } }, options);
    try {
      const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
      assert.equal(session.status, 'error'); assert.equal(reviews, 0); assert.equal(f.localApplications, 0);
    } finally { f.close(); }
  }
});

test('mask selection or native range changes during review reject the local write', async () => {
  for (const change of ['selection', 'range']) {
    let calls = 0;
    const f = fixture({ async decide() {
      if (++calls === 1) return decision({ action: 'inspect', detailPoints: [{ id: 'edge', label: 'Visible subject edge', x: 0.5, y: 0.5 }] });
      if (change === 'selection') f.manualMaskSelection('other-mask'); else f.changeMaskRange(3);
      return decision({ action: 'local-edit', maskId: 'subject-mask', adjustments: { local_Exposure: 0.2 } });
    } }, { localEdits: true, existingMask: true });
    try {
      const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
      assert.equal(session.status, 'error'); assert.match(session.error!, /changed during review/);
      assert.equal(f.localApplications, 0); assert.equal(f.applications, 0);
    } finally { f.close(); }
  }
});

test('uncertain mask write keeps the session lock and never attempts restore or retry', async () => {
  let calls = 0;
  const f = fixture({ async decide() {
    return ++calls === 1 ? decision({ action: 'inspect', detailPoints: [{ id: 'edge', label: 'Visible subject edge', x: 0.5, y: 0.5 }] })
      : decision({ action: 'local-edit', maskId: 'subject-mask', adjustments: { local_Exposure: 0.2 } });
  } }, { localEdits: true, existingMask: true, failMaskApply: true });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.status, 'error'); assert.equal(session.retryable, false);
    assert.equal(f.localApplications, 1); assert.equal(f.restorations, 0);
    assert.ok(existsSync(join(f.root, 'session.lock')));
  } finally { f.close(); }
});

test('pause aborts image inspection before an edit and resume continues from the checkpoint',async()=>{
  let calls=0;let began!:()=>void;const ready=new Promise<void>(resolve=>began=resolve);
  const f=fixture({async decide(_input,signal){
    if(++calls===1){began();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}
    return decision();
  }});
  try{
    const s=f.engine.start({useSelected:true,intent:'Natural'});await ready;f.engine.pause(s.id);await f.engine.idle();
    assert.equal(s.status,'paused');assert.equal(f.applications,0);
    f.engine.resume(s.id);await f.engine.idle();assert.equal(s.status,'completed');assert.equal(calls,2);
  }finally{f.close();}
});

test('human answers are bound to the pending question and included in the next model observation',async()=>{
  let calls=0;
  const f=fixture({async decide(input){if(++calls===1)return decision({action:'ask',question:'Which direction?',options:['Natural','Dramatic']});assert.match(input.feedback[0],/Natural/);return decision();}});
  try{
    const s=f.engine.start({useSelected:true,intent:'A wildlife portrait'});await f.engine.idle();
    assert.equal(s.status,'awaiting_answer');assert.throws(()=>f.engine.answer(s.id,'stale','Natural'));
    f.engine.answer(s.id,s.question!.id,'Natural');await f.engine.idle();assert.equal(s.status,'completed');
  }finally{f.close();}
});

test('uncertain native failure stops the loop and does not retry the edit',async()=>{
  const f=fixture({async decide(){return decision({action:'edit',adjustments:{Exposure2012:0.25}});}},{failApply:true});
  try{
    const s=f.engine.start({useSelected:true,intent:'Natural'});await f.engine.idle();
    assert.equal(s.status,'error');assert.equal(f.applications,1);assert.equal(f.store.getRun(s.runId!)!.status,'interrupted');
    assert.equal(existsSync(join(f.root,'session.lock')),true);assert.throws(()=>f.engine.resume(s.id));
    assert.throws(()=>f.engine.start({useSelected:true,intent:'Another run'}),/Another editing session/);
  }finally{f.close();}
});

test('edit budget includes a final visual assessment without allowing another adjustment',async()=>{
  let calls=0;
  const f=fixture({async decide(input){calls++;return input.remainingEdits ? decision({action:'edit',adjustments:{Exposure2012:0.25*calls},reason:`Remaining ${input.remainingEdits}`}) : decision();}},{maxEdits:1});
  try{
    const s=f.engine.start({useSelected:true,intent:'Natural'});await f.engine.idle();
    assert.equal(s.status,'awaiting_choice');assert.equal(f.applications,1);assert.equal(calls,2);
  }finally{f.close();}
});

test('existing CLI session lock prevents demo start',()=>{
  const f=fixture({async decide(){return decision();}});
  try{writeFileSync(join(f.root,'session.lock'),'existing');assert.throws(()=>f.engine.start({useSelected:true,intent:'Natural'}),/Another editing session/);assert.equal(f.engine.session,null);}finally{f.close();}
});

test('later decisions prioritize the baseline and immediate parent for visual comparison',async()=>{
  let calls=0;let previousId='';
  const f=fixture({async decide(input){
    calls++;
    if(calls>=3) assert.equal(input.candidates[1].id,previousId);
    previousId=input.currentCandidateId;
    return calls<=3 ? decision({action:'edit',adjustments:{Exposure2012:calls*0.1}}) : decision();
  }});
  try {const s=f.engine.start({useSelected:true,intent:'Natural'});await f.engine.idle();assert.equal(s.status,'awaiting_choice');assert.equal(calls,4);}
  finally {f.close();}
});

test('finish during a human question retains actual checkpoints',async()=>{
  const f=fixture({async decide(){return decision({action:'ask',question:'Mood?',options:['Calm','Bold']});}});
  try{const s=f.engine.start({useSelected:true,intent:'Natural'});await f.engine.idle();f.engine.stop(s.id);await f.engine.idle();assert.equal(s.status,'completed');assert.equal(s.question,undefined);}finally{f.close();}
});

test('detail inspection uses saved exports across candidates without replacing overviews or rerendering old states', async () => {
  const point = { id: 'subject', label: 'Visible subject', x: 0.35, y: 0.45 };
  let calls = 0;
  const f = fixture({ async decide(input) {
    calls++;
    if (calls === 1) return decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } });
    if (calls === 2) return decision({ action: 'inspect', detailPoints: [point] });
    for (const candidate of input.candidates) {
      assert.equal(candidate.details.length, 1); assert.equal(candidate.details[0].sourceWidth, 240);
      assert.equal(candidate.details[0].width, 160); assert.equal(candidate.details[0].x, point.x);
    }
    return calls === 3 ? decision({ action: 'edit', adjustments: { Texture: 2 } }) : decision();
  } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.status, 'awaiting_choice'); assert.equal(calls, 4);
    assert.deepEqual(f.renders.map(render => render.maxEdge), [2048, 8192, 2048, 8192, 2048, 8192]);
    for (const [index, candidate] of session.candidates.entries()) {
      assert.equal(f.engine.preview(session.id, candidate.id), f.renders[index * 2].path);
      assert.equal(candidate.details[0].id, point.id);
      assert.ok(existsSync(f.engine.detail(session.id, candidate.id, point.id)));
    }
    assert.throws(() => f.engine.detail('old-session', session.candidates[0].id, point.id));
    assert.throws(() => f.engine.detail(session.id, session.candidates[0].id, '../secret'));
    assert.ok(!JSON.stringify(session).includes(f.root));
    const saved = JSON.parse(readFileSync(join(f.root, 'demo', 'session.json'), 'utf8'));
    assert.equal(Object.keys(saved.detailSources).length, 3);
    assert.equal(saved.detailSources[session.candidates[0].id].path, f.renders[1].path);
    const restored = new DemoEngine(f.controller, { async decide() { throw new Error('Must not review on load'); } }, f.root);
    assert.equal(restored.session!.status, 'error'); assert.equal(restored.session!.retryable, false);
    assert.equal(restored.detail(session.id, session.candidates[0].id, point.id), f.engine.detail(session.id, session.candidates[0].id, point.id));
  } finally { f.close(); }
});

test('review retry preserves the active checkpoint and lock without repeating native edits or exports', async () => {
  let calls = 0;
  const f = fixture({ async decide(input) {
    assert.ok(f.engine.session!.inspectionStartedAt);
    if (++calls === 1) return decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } });
    if (calls === 2) throw new PhotoAgentError('TIMEOUT', 'Review timed out');
    assert.equal(input.candidates.find((candidate: { id: string }) => candidate.id === input.currentCandidateId).settings.Exposure2012, 0.1);
    return decision({ action: 'ask', question: 'Mood?', options: ['Calm', 'Bold'] });
  } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.status, 'error'); assert.equal(session.retryable, true); assert.equal(session.inspectionStartedAt, undefined);
    assert.equal(f.store.getRun(session.runId!)!.status, 'active'); assert.ok(existsSync(join(f.root, 'session.lock')));
    const checkpoint = session.currentCandidateId; const renderCount = f.renders.length;
    assert.throws(() => f.engine.start({ useSelected: true, intent: 'Other' }), /Retry inspection/);
    f.engine.retry(session.id); assert.throws(() => f.engine.retry(session.id)); await f.engine.idle();
    assert.equal(session.status, 'awaiting_answer'); assert.equal(session.currentCandidateId, checkpoint);
    assert.equal(f.applications, 1); assert.equal(f.renders.length, renderCount); assert.equal(session.error, undefined);
    assert.equal(session.retryable, false); assert.equal(session.inspectionStartedAt, undefined);
    f.engine.stop(session.id); await f.engine.idle();
  } finally { f.close(); }
});

test('native export failures and incompatible dimensions never expose review retry', async () => {
  for (const options of [{ failExport: true }, { mismatchedExport: true }]) {
    const f = fixture({ async decide() { return decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } }); } }, options);
    try {
      const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
      assert.equal(session.status, 'error'); assert.equal(session.retryable, false); assert.throws(() => f.engine.retry(session.id));
      assert.equal(session.candidates.some(candidate => candidate.details.length), false);
      if (options.mismatchedExport) assert.match(session.error!, /dimensions changed/);
    } finally { f.close(); }
  }
});

test('a stale current-candidate decision is rejected before applying or exporting another edit', async () => {
  const f = fixture({ async decide() { return decision({ action: 'edit', candidateId: 'stale-candidate', adjustments: { Exposure2012: 0.2 } }); } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.status, 'error'); assert.equal(session.retryable, false); assert.equal(f.applications, 0);
    assert.equal(f.renders.length, 2); assert.throws(() => f.engine.retry(session.id));
  } finally { f.close(); }
});

test('server restart does not make a saved provider-review failure safe to resume', async () => {
  const f = fixture({ async decide() { throw new PhotoAgentError('PROVIDER_FAILED', 'Provider failed'); } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.retryable, true);
    const restored = new DemoEngine(f.controller, { async decide() { throw new Error('Must not review on load'); } }, f.root);
    assert.equal(restored.session!.retryable, false); assert.throws(() => restored.retry(session.id));
    assert.ok(existsSync(join(f.root, 'session.lock'))); assert.equal(f.store.getRun(session.runId!)!.status, 'interrupted');
    await f.engine.shutdown();
  } finally { f.close(); }
});

test('manual changes after a provider timeout halt retry before another review or native write', async () => {
  let calls = 0;
  const f = fixture({ async decide(input) {
    if (++calls === 1) return decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } });
    if (calls === 2) throw new PhotoAgentError('TIMEOUT', 'Review timed out');
    return decision({ action: 'restore', candidateId: input.candidates[0].id });
  } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(session.retryable, true);
    const renderCount = f.renders.length;
    f.manualEdit({ Exposure2012: 1.5 });
    f.engine.retry(session.id); await f.engine.idle();
    assert.equal(calls, 2); assert.equal(session.status, 'error'); assert.equal(session.retryable, false);
    assert.match(session.error!, /manual changes are preserved/);
    assert.equal(f.settings.Exposure2012, 1.5); assert.equal(f.restorations, 0);
    assert.equal(f.applications, 1); assert.equal(f.renders.length, renderCount);
    assert.equal(f.store.getRun(session.runId!)!.status, 'interrupted'); assert.throws(() => f.engine.retry(session.id));
  } finally { f.close(); }
});

test('manual changes during model review prevent its restore decision from overwriting Lightroom', async () => {
  let calls = 0; let release!: () => void; let ready!: () => void;
  const reviewing = new Promise<void>(resolve => ready = resolve);
  const f = fixture({ async decide(input) {
    if (++calls === 1) return decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } });
    await new Promise<void>(resolve => { release = resolve; ready(); });
    return decision({ action: 'restore', candidateId: input.candidates[0].id });
  } });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await reviewing;
    const renderCount = f.renders.length;
    f.manualEdit({ Exposure2012: 1.25 }); release(); await f.engine.idle();
    assert.equal(session.status, 'error'); assert.equal(session.retryable, false);
    assert.equal(f.settings.Exposure2012, 1.25); assert.equal(f.restorations, 0);
    assert.equal(f.applications, 1); assert.equal(f.renders.length, renderCount);
    assert.match(session.error!, /manual changes are preserved/);
  } finally { f.close(); }
});

test('restore checks the reviewed prior token again if Lightroom changes after the general decision guard', async () => {
  let calls = 0; let changed = false;
  const f = fixture({ async decide(input) {
    return ++calls === 1 ? decision({ action: 'edit', adjustments: { Exposure2012: 0.1 } })
      : decision({ action: 'restore', candidateId: input.candidates[0].id });
  } });
  f.engine.on('change', () => {
    if (!changed && f.engine.session?.events.at(-1)?.type === 'restore') {
      changed = true; f.manualEdit({ Exposure2012: 1.75 });
    }
  });
  try {
    const session = f.engine.start({ useSelected: true, intent: 'Natural' }); await f.engine.idle();
    assert.equal(changed, true); assert.equal(session.status, 'error'); assert.equal(session.retryable, false);
    assert.match(session.error!, /changed since the reviewed checkpoint/);
    assert.equal(f.settings.Exposure2012, 1.75); assert.equal(f.restorations, 0);
    assert.equal(f.applications, 1); assert.equal(f.renders.length, 4);
  } finally { f.close(); }
});
