import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireServerLock, allowRequest, receiveUpload, validateFilename } from '../src/demo/server.ts';

function request(headers: Record<string,string>, method='GET') {return {headers,method} as IncomingMessage;}
test('a second server cannot recover or overwrite the active project session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rpa-server-lock-test-'));
  try { const release=await acquireServerLock(root); await assert.rejects(acquireServerLock(root),/already running/); await release(); const again=await acquireServerLock(root); await again(); }
  finally { await rm(root,{recursive:true,force:true}); }
});
test('local demo rejects foreign origins, host rebinding, cross-site images and unmarked mutations',()=>{
  assert.equal(allowRequest(request({host:'127.0.0.1:4318'}),4318),true);
  assert.equal(allowRequest(request({host:'example.com:4318'}),4318),false);
  assert.equal(allowRequest(request({host:'127.0.0.1:4318',origin:'https://foreign.example'}),4318),false);
  assert.equal(allowRequest(request({host:'127.0.0.1:4318','sec-fetch-site':'cross-site'}),4318),false);
  assert.equal(allowRequest(request({host:'127.0.0.1:4318'},'POST'),4318),false);
  assert.equal(allowRequest(request({host:'127.0.0.1:4318',origin:'http://127.0.0.1:4318','x-rpa-client':'demo'},'POST'),4318),true);
});
test('RAW filename validation rejects paths and non-RAW files',()=>{
  assert.equal(validateFilename('Photo 1.CR3'),'Photo 1.CR3');
  for(const name of ['../photo.cr3','sub/photo.cr3','sub\\photo.cr3','test.jpg','x\0.cr3','.hidden.cr3','x..cr3'])assert.throws(()=>validateFilename(name));
});
test('binary upload preserves source bytes under a unique directory',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'rpa-upload-test-')));
  try{
    const bytes=Buffer.from('test camera bytes');const stream=Readable.from([bytes.subarray(0,4),bytes.subarray(4)]) as IncomingMessage;
    stream.headers={'x-filename':'Camera%20photo.CR3','content-type':'application/octet-stream','content-length':String(bytes.length)};
    const result=await receiveUpload(stream,root);assert.equal(result.name,'Camera photo.CR3');assert.deepEqual(await readFile(result.path),bytes);
    assert.equal(result.size,bytes.length);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('incomplete uploads are removed and cannot be imported',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'rpa-upload-test-')));
  try{
    const stream=Readable.from([Buffer.from('partial')]) as IncomingMessage;
    stream.headers={'x-filename':'photo.cr3','content-type':'application/octet-stream','content-length':'100'};
    await assert.rejects(receiveUpload(stream,root),/incomplete/);assert.deepEqual(await readdir(root),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
