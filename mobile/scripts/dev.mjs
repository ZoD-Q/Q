#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const native = args.includes('--native');
const forwardedArgs = args.filter(arg => arg !== '--native');
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = ['run', native ? 'start' : 'web', '--workspace=@xiaoq/native'];
if (forwardedArgs.length > 0) npmArgs.push('--', ...forwardedArgs);

console.log(native
  ? 'Starting the mobile Expo development server.'
  : 'Starting the standalone mobile UI browser preview.');

// Frontend-only launcher: no database, backend process, health probe or backend env file.
const frontend = spawn(command, npmArgs, {
  cwd: mobileRoot,
  env: process.env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});
let stopping = false;
let forcedExit;

function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (process.platform === 'win32') frontend.kill('SIGINT');
    else process.kill(-frontend.pid, 'SIGINT');
  } catch { /* The UI process may already have exited. */ }
  forcedExit = setTimeout(() => {
    try {
      if (process.platform === 'win32') frontend.kill('SIGKILL');
      else process.kill(-frontend.pid, 'SIGKILL');
    } catch { /* Already exited. */ }
  }, 4000);
  forcedExit.unref();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
frontend.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
frontend.once('exit', (code, signal) => {
  clearTimeout(forcedExit);
  process.exitCode = stopping ? 0 : code ?? (signal ? 1 : 0);
});
