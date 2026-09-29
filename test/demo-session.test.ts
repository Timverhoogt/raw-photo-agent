import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { RunStore } from '../src/store.ts';
import { PhotoController } from '../src/controller.ts';
import { DemoEngine } from '../src/demo/session.ts';
import type { Decision } from '../src/agent/core.ts';

function decision(overrides: Partial<Decision> = {}): Decision { return {action:'finish',title:'Ready',observation:'The visible detail is retained.',reason:'Compare the versions.',adjustments:{},candidateId:null,question:null,options:[],...overrides}; }
function fixture(agent: {decide: (...args:any[])=>Promise<Decision>}, options: {failApply?:boolean; maxEdits?:number} = {}) {
  const root = mkdtempSync(join(tmpdir(),'rpa-demo-test-')); const store = new RunStore(join(root,'test.sqlite'));
  const snapshots = new Map<string,Record<string,number>>(); let settings = {Exposure2012:0}; let selected='source'; let applications=0;
  const original = {...settings};
  const state = () => ({photoId:selected,settings:{...settings},stateToken:JSON.stringify({selected,settings})});
  const bridge = {async call<T>(operation:string,params:Record<string,unknown> = {}):Promise<T> {
    let result:unknown;
    if(operation==='selected') result={count:1,photos:[{photoId:selected,name:'sample.cr3',fileFormat:'RAW',isVirtualCopy:selected==='copy'}]};
    else if(operation==='reveal_photo') result={};
    else if(operation==='read_state') result=state();
    else if(operation==='create_working_copy') {selected='copy';result={photoId:selected};}
    else if(operation==='checkpoint') {const id=`snapshot-${snapshots.size}`;snapshots.set(id,{...settings});result={snapshotId:id,state:state()};}
    else if(operation==='apply') {applications++;if(options.failApply)throw Object.assign(new Error('uncertain render response'),{outcomeUncertain:true});settings={...settings,...params.adjustments as object};result={state:state()};}
    else if(operation==='restore') {settings={...snapshots.get(String(params.snapshotId))} as typeof settings; result={state:state()};}
    else if(operation==='render') {
      const value=Math.max(0,Math.min(255,100+Math.round(settings.Exposure2012*40)));
      await sharp({create:{width:24,height:16,channels:3,background:{r:value,g:value,b:value}}}).jpeg().toFile(String(params.outputPath));
      result={outputPath:params.outputPath,photoId:selected,stateToken:state().stateToken};
    } else throw new Error(`unexpected operation ${operation}`);
    return result as T;
  }};
  const controller = new PhotoController(bridge,store,join(root,'renders'));
  const engine = new DemoEngine(controller,agent,root,{load:false,maxEdits:options.maxEdits});
  return {root,store,engine,get applications(){return applications},get settings(){return settings},original,close(){store.close();rmSync(root,{recursive:true,force:true});}};
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
  const f=fixture({async decide(input){calls++;return decision({action:'edit',adjustments:{Exposure2012:0.25*calls},reason:`Remaining ${input.remainingEdits}`});}},{maxEdits:1});
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
