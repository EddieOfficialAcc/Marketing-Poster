import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('application boots after shared state initialization and registers editor actions',()=>{
 const env={...process.env};delete env.STARTUP_SOURCE;
 const result=spawnSync(process.execPath,['--experimental-vm-modules','tests/helpers/app-startup-smoke.mjs'],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),env,encoding:'utf8',timeout:15000,
 });
 assert.equal(result.status,0,result.stderr||result.error?.message);
 assert.match(result.stdout,/App startup completed/);
});
