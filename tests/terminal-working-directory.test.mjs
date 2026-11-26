import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalTerminalSessions } from '../dist-electron/local-terminal-sessions.js';
import { DaemonTerminalSessions } from '../dist-electron/daemon-terminal-sessions.js';

test('manual terminal launch rejects missing/file cwd before starting a native process', async t => {
  const dir=mkdtempSync(join(tmpdir(),'aha-terminal-cwd-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'file');writeFileSync(file,'not a directory');
  let spawned=0;
  const local=new LocalTerminalSessions({spawn(){spawned++;throw Error('unexpected spawn');}}, {data(){},exit(){}},()=>dir);
  const daemon=new DaemonTerminalSessions({dataDir:dir},{data(){},exit(){}},()=>dir);
  daemon.getClient=async()=>({attach:async()=>{throw Error('Unknown terminal');},spawn:async()=>{spawned++;throw Error('unexpected spawn');}});
  for(const cwd of [join(dir,'missing'),file]){
    assert.throws(()=>local.create({terminalId:'local-'+spawned,shellId:'default',cwd}),/终端工作目录/);
    await assert.rejects(daemon.create({terminalId:'daemon-'+spawned,shellId:'default',cwd}),/终端工作目录/);
  }
  assert.equal(spawned,0);
});
