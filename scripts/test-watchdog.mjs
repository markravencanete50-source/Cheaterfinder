import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'cheaterfinder-watchdog-test-'));
const script=resolve('scripts/healthcheck.sh');
const run=(command,args,env)=>new Promise((resolve,reject)=>{const p=spawn(command,args,{cwd:tmpdir(),env,stdio:'ignore'});p.on('error',reject);p.on('close',resolve)});
const results=[];
try{
 await writeFile(join(temp,'pm2'),'#!/bin/sh\necho restart >> "$TEST_RESTARTS"\n',{mode:0o700});
 for(const scenario of ['healthy','5xx','refused','timeout','4xx']){
  let requests=0;
  const server=createServer((_req,res)=>{requests++;if(scenario==='timeout')return;res.statusCode=scenario==='5xx'&&requests===1?503:scenario==='4xx'?404:200;res.end('{}')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  if(scenario==='refused')await new Promise(r=>server.close(r));
  const log=join(temp,scenario+'.log'),restarts=join(temp,scenario+'.restarts');
  await writeFile(join(temp,'fixture.env'),`PORT="${port}"\n`);
  const code=await run('/bin/bash',[script],{PATH:process.env.PATH,WATCHDOG_ENV_FILE:join(temp,'fixture.env'),WATCHDOG_LOG_FILE:log,WATCHDOG_TIMEOUT:'0.2',WATCHDOG_RESTART_DELAY:'0',PM2_BIN:join(temp,'pm2'),TEST_RESTARTS:restarts});
  const lines=await readFile(log,'utf8'), restarted=await readFile(restarts,'utf8').then(x=>x.trim().split('\n').length).catch(()=>0);
  assert.equal(restarted,['5xx','refused','timeout'].includes(scenario)?1:0);
  assert.equal(code,['healthy','5xx'].includes(scenario)?0:1);
  assert(!lines.includes('000000'));
  server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));
  results.push({scenario,exitCode:code,restarts:restarted,passed:true});
 }
 const code=await run('/bin/bash',['-c','source "$1"','test',resolve('scripts/database-monitor-env.sh')],{PATH:process.env.PATH,PGPASSFILE:join(temp,'missing')});assert.equal(code,2);
 console.log(JSON.stringify({results,missingCredentialsFailClosed:true},null,2));
}finally{await rm(temp,{recursive:true,force:true})}
