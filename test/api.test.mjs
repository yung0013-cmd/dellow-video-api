import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, ffmpeg, probe } from '../media.mjs';

const folder=path.dirname(fileURLToPath(import.meta.url));
test('native API encodes and verifies MP4, preserves trim/audio, validates auth and corrupt files', {timeout:120000}, async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'dellow-test-'));
  const key=randomBytes(24).toString('hex');
  const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(folder,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:'0',API_TOKEN:key},windowsHide:true});
  const base=await new Promise((resolve,reject)=>{let log='';child.stdout.on('data',data=>{log+=data;const match=log.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match)resolve(match[0]);});child.on('error',reject);child.on('exit',code=>reject(new Error('server exit '+code)));});
  t.after(async()=>{child.kill();await rm(temp,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${key}`};
  assert.equal((await fetch(base+'/v1/connection')).status,401);
  assert.equal((await fetch(base+'/v1/connection',{headers})).status,200);
  assert.equal((await fetch(base+'/v1/connection',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  const input=path.join(temp,'input.mp4');
  await command(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv444p','-c:a','alac',input]);
  const source=await readFile(input);
  async function submit(bytes,start,end,subtitle){const form=new FormData();form.set('video',new Blob([bytes]),'input.mp4');form.set('start',String(start));form.set('end',String(end));if(subtitle)form.set('subtitle',new Blob([subtitle]),'subtitle.png');return fetch(base+'/v1/jobs',{method:'POST',headers,body:form});}
  async function complete(id){for(let i=0;i<200;i++){const state=await(await fetch(base+'/v1/jobs/'+id,{headers})).json();if(['ready','failed'].includes(state.status))return state;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');}
  assert.equal((await submit(source,3,1)).status,400);
  const id=(await(await submit(source,1,4)).json()).id;
  const ready=await complete(id);assert.equal(ready.status,'ready',JSON.stringify(ready));
  assert.equal(ready.report.video.codec_name,'h264');assert.equal(ready.report.video.pix_fmt,'yuv420p');assert.equal(ready.report.audio.codec_name,'aac');assert.equal(ready.report.fullDecode,'passed');assert.equal(Number(ready.report.duration),3);
  assert.equal((await fetch(base+'/v1/jobs/'+id+'/file?ticket=wrong')).status,404);
  const response=await fetch(base+ready.downloadPath);assert.equal(response.headers.get('content-type'),'video/mp4');assert.match(response.headers.get('content-disposition'),/attachment.*\.mp4/);
  const output=new Uint8Array(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),output.length);assert.equal(createHash('sha256').update(output).digest('hex'),ready.report.sha256);
  assert.equal((await fetch(base+ready.downloadPath,{headers:{Range:'bytes=0-99'}})).status,206);
  const downloaded=path.join(temp,'download.mp4');await writeFile(downloaded,output);assert.equal((await probe(downloaded)).streams[0].codec_name,'h264');
  await fetch(base+'/v1/jobs/'+id,{method:'DELETE',headers});assert.equal((await fetch(base+ready.downloadPath)).status,404);
  const silentFile=path.join(temp,'silent.mp4');await command(ffmpeg,['-v','error','-y','-i',input,'-map','0:v:0','-c:v','copy','-an',silentFile]);
  const silentId=(await(await submit(await readFile(silentFile),0,2)).json()).id;
  const silentReady=await complete(silentId);assert.equal(silentReady.status,'ready');assert.equal(silentReady.report.audio.codec_name,'aac');assert.equal(silentReady.report.fullDecode,'passed');await fetch(base+'/v1/jobs/'+silentId,{method:'DELETE',headers});
  const badId=(await(await submit(Buffer.from('not-an-mp4'),0,2)).json()).id;assert.equal((await complete(badId)).status,'failed');await fetch(base+'/v1/jobs/'+badId,{method:'DELETE',headers});
  const malformedId=(await(await submit(source,0,2,Buffer.from('not-a-png'))).json()).id;assert.equal((await complete(malformedId)).status,'failed');await fetch(base+'/v1/jobs/'+malformedId,{method:'DELETE',headers});
  const cancelId=(await(await submit(source,0,4)).json()).id;await fetch(base+'/v1/jobs/'+cancelId,{method:'DELETE',headers});assert.equal((await fetch(base+'/v1/jobs/'+cancelId,{headers})).status,404);
});
