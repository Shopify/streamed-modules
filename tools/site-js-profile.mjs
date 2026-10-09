// Profiles a live site's startup JavaScript: how many module files, how many
// bytes, and what the same code would cost as ONE brotli stream - i.e. what a
// module-declarations bundle of it would weigh versus today's per-file
// compression.
//
//   node tools/site-js-profile.mjs https://example.com/ [--chrome /path] [--settle 10000]
//
// Uses CDP Network.getResponseBody, so it works on bot-protected sites that
// refuse curl, as long as a real Chrome can load them.

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {brotliCompressSync, constants} from 'node:zlib';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const url = process.argv[2];
const chrome = arg('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const settle = Number(arg('settle', 10000));
const port = 9800 + Math.floor(Math.random() * 100);

const profile = await mkdtemp(join(tmpdir(), 'js-profile-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, '--window-size=1400,900', 'about:blank',
], {stdio: 'ignore'});

let wsUrl = null;
for (let i = 0; i < 200 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  } catch {}
  if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, {once: true}));

let id = 1;
const pending = new Map();
const responses = new Map(); // requestId -> {url, mimeType, encodedDataLength}
const finished = new Set();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (/\.m?js(\?|$)/.test(r.url) || /javascript/.test(r.mimeType)) {
      responses.set(m.params.requestId, {url: r.url, mimeType: r.mimeType, ts: m.params.timestamp});
    }
  } else if (m.method === 'Network.loadingFinished') {
    if (responses.has(m.params.requestId)) {
      responses.get(m.params.requestId).encodedDataLength = m.params.encodedDataLength;
      finished.add(m.params.requestId);
    }
  }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = id++; pending.set(myId, {resolve, reject});
  ws.send(JSON.stringify({id: myId, method, params}));
});

await call('Network.enable', {maxResourceBufferSize: 200 * 1024 * 1024, maxTotalBufferSize: 400 * 1024 * 1024});
await call('Page.enable');
await call('Page.navigate', {url});
await new Promise((r) => setTimeout(r, settle));

const files = [];
for (const [reqId, info] of responses) {
  if (!finished.has(reqId)) continue;
  try {
    const {body, base64Encoded} = await call('Network.getResponseBody', {requestId: reqId});
    const buf = Buffer.from(body, base64Encoded ? 'base64' : 'utf8');
    files.push({...info, body: buf});
  } catch {}
}
files.sort((a, b) => a.ts - b.ts);

const kb = (n) => (n / 1024).toFixed(0);
const br = (buf) => brotliCompressSync(buf, {params: {[constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length}}).length;

const decoded = files.reduce((a, f) => a + f.body.length, 0);
const wire = files.reduce((a, f) => a + (f.encodedDataLength || 0), 0);
const perFileBr = files.reduce((a, f) => a + br(f.body), 0);
const concatBr = br(Buffer.concat(files.map((f) => f.body)));

console.log(`${url}`);
console.log(`  JS files fetched:            ${files.length}`);
console.log(`  uncompressed:                ${kb(decoded)} kB`);
console.log(`  as served (wire, incl hdrs): ${kb(wire)} kB`);
console.log(`  re-compressed per file, br11:${kb(perFileBr).padStart(6)} kB`);
console.log(`  concatenated, one br11 stream:${kb(concatBr).padStart(5)} kB   (${(100 * (1 - concatBr / perFileBr)).toFixed(1)}% smaller than per-file)`);
console.log(`  largest files:`);
for (const f of files.slice().sort((a, b) => b.body.length - a.body.length).slice(0, 6)) {
  console.log(`    ${kb(f.body.length).padStart(5)} kB  ${f.url.split('/').pop().slice(0, 60)}`);
}

ws.close();
child.kill('SIGKILL');
await rm(profile, {recursive: true, force: true});
