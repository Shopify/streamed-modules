// Tiny CDP probe: load a URL, poll one JS expression until it settles or the
// main thread stops answering. Used to characterise how inline-module
// injection scales.
//
//   node tools/probe.mjs <url> "<expression>" [timeoutMs]

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

process.on('unhandledRejection', (err) => {
  console.log('UNHANDLED', err?.message ?? err);
});

const url = process.argv[2];
const expression = process.argv[3] || 'document.title';
const timeout = Number(process.argv[4] || 30000);
const chrome = process.env.CHROME;
if (!chrome) {
  console.error('Set CHROME to the path of a Chromium built with CL 5649434.');
  process.exit(2);
}
const port = 9400 + Math.floor(Math.random() * 400);

const profile = await mkdtemp(join(tmpdir(), 'smp-probe-'));
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--enable-blink-features=ModuleDeclarations',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  {stdio: ['ignore', 'ignore', 'pipe']},
);
child.stderr.resume();

const cleanup = async (code) => {
  try {
    child.kill('SIGKILL');
  } catch {}
  await rm(profile, {recursive: true, force: true});
  process.exit(code);
};
setTimeout(() => {
  console.log('WATCHDOG');
  cleanup(2);
}, timeout + 15000).unref?.();

let wsUrl = null;
for (let i = 0; i < 150 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  } catch {}
  if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
}
if (!wsUrl) {
  console.log('NO DEVTOOLS');
  await cleanup(3);
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, {once: true}));
let id = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION', m.params.exceptionDetails.text,
      m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? '');
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('CONSOLE.ERROR',
      m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  }
});
const call = (method, params = {}, ms = 15000) =>
  Promise.race([
    new Promise((resolve, reject) => {
      const myId = id++;
      pending.set(myId, {resolve, reject});
      ws.send(JSON.stringify({id: myId, method, params}));
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('BUSY')), ms)),
  ]);

await call('Runtime.enable');
await call('Page.enable');
const t0 = Date.now();
// Navigation can legitimately take a while on a throttled link, and it must
// not be raced against a short timeout.
await call('Page.navigate', {url}, timeout);

let last = null;
let busy = 0;
while (Date.now() - t0 < timeout) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const {result} = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    const value = result.value === undefined ? '<undefined>' : result.value;
    if (value !== last) {
      console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(value)}`);
      last = value;
    }
    if (typeof value === 'string' && value.includes('DONE')) break;
  } catch {
    busy++;
  }
}
console.log(`blocked probes: ${busy}, elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ws.close();
await cleanup(0);
