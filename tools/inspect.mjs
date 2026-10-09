// Minimal CDP driver: launches the patched Chromium, loads a URL, streams the
// page's console output, and dumps __SMP__ / __RESULTS__ when the app is ready.
//
//   node tools/inspect.mjs http://localhost:8112/
//
// Useful when a run produces nothing and you need to see why.

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.argv[2] || 'http://localhost:8112/';
// Optional: write a PNG once the app reports itself ready (the load event is
// too early - it can fire before the first paint).
const screenshotPath = process.argv[3] || null;
const chrome = process.env.CHROME;
if (!chrome) {
  console.error('Set CHROME to the path of a Chromium built with CL 5649434.');
  process.exit(2);
}
const port = 9333 + (Number(process.env.PORT_OFFSET) || 0);
const timeout = Number(process.env.TIMEOUT_MS || 60000);

const profile = await mkdtemp(join(tmpdir(), 'smp-inspect-'));
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
    '--window-size=1400,900',
    'about:blank',
  ],
  {stdio: ['ignore', 'ignore', 'pipe']},
);
child.stderr.resume();

async function targetWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === 'page');
      if (pages[0]?.webSocketDebuggerUrl) return pages[0].webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('devtools endpoint never came up');
}

const ws = new WebSocket(await targetWs());
await new Promise((r) => ws.addEventListener('open', r, {once: true}));

let nextId = 1;
const pending = new Map();
const sendRaw = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
  });

// Runtime.evaluate waits on the renderer's main thread, so a page that blocks
// it would hang this script forever.
const send = (method, params = {}, ms = 5000) =>
  Promise.race([
    sendRaw(method, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${method} timed out after ${ms}ms`)), ms),
    ),
  ]);

// Belt and braces: never let a wedged renderer wedge the harness.
const watchdog = setTimeout(() => {
  console.log('\n[watchdog] giving up, killing browser');
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(2);
}, timeout + 20000);
watchdog.unref?.();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    console.log(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log(
      `[exception] ${d.text} ${d.exception?.description ?? ''} ` +
        `@${d.url ?? ''}:${d.lineNumber ?? '?'}`,
    );
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    console.log(`[log.${e.level}] ${e.text}${e.url ? ' @' + e.url : ''}`);
  }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

const failures = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Network.loadingFailed') failures.push(msg.params);
});

const t0 = Date.now();
await send('Page.navigate', {url});

let results = null;
let blocked = 0;
while (Date.now() - t0 < timeout) {
  await new Promise((r) => setTimeout(r, 400));
  let result;
  try {
    ({result} = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      ready: document.documentElement.getAttribute('data-app-ready'),
      marks: window.__SMP__ && window.__SMP__.marks,
      mods: window.__SMP__ && window.__SMP__.modExec.length,
      registered: window.__SMP__ && window.__SMP__.registered.length,
      rootHtml: (document.getElementById('root')||{}).innerHTML ?
        (document.getElementById('root').innerHTML.length + ' bytes') : 'empty',
      scripts: document.querySelectorAll('script[type=module]').length,
      results: window.__RESULTS__ || null
    })`,
    returnByValue: true,
    }));
  } catch (err) {
    blocked++;
    process.stdout.write(
      `\rt=${((Date.now() - t0) / 1000).toFixed(1)}s main thread busy ` +
        `(${blocked} probes blocked)      `,
    );
    continue;
  }
  const snapshot = JSON.parse(result.value);
  process.stdout.write(
    `\rt=${((Date.now() - t0) / 1000).toFixed(1)}s mods=${snapshot.mods} ` +
      `features=${snapshot.registered} scripts=${snapshot.scripts} ` +
      `root=${snapshot.rootHtml} ready=${snapshot.ready}   `,
  );
  if (snapshot.ready === '1') {
    results = snapshot;
    break;
  }
}
console.log('\n');
console.log(results ? JSON.stringify(results, null, 2) : 'TIMED OUT (no data-app-ready)');

if (results && screenshotPath) {
  // One more frame so the paint that follows `rendered` is on screen.
  await new Promise((r) => setTimeout(r, 500));
  const shot = await send('Page.captureScreenshot', {format: 'png'}, 20000);
  const {writeFile} = await import('node:fs/promises');
  await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot -> ${screenshotPath}`);
}
if (failures.length) {
  console.log(`\n${failures.length} network failures, first few:`);
  for (const f of failures.slice(0, 8)) console.log(`  ${f.errorText} ${f.type}`);
}

if (!results) {
  const {result} = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      marks: window.__SMP__ && window.__SMP__.marks,
      mods: window.__SMP__ && window.__SMP__.modExec.length,
      lastMods: window.__SMP__ ? window.__SMP__.modExec.slice(-3) : null
    })`,
    returnByValue: true,
  });
  console.log('final state:', result.value);
}

ws.close();
child.kill('SIGKILL');
await rm(profile, {recursive: true, force: true});
process.exit(results ? 0 : 1);
