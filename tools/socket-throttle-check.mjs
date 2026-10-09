// Sanity check for network throttling (socket-layer by default, CDP's legacy
// URLLoader throttling with --legacy): a local HTTP/1.1 server serves a 200 kB
// page that fetches two 1 MB incompressible files over two connections, either
// while the page is still arriving or, with --defer, after its load event.
// Expected with socket-layer delay: TTFB = connect + request RTTs, the two
// fetches share one budget (together ~2 MB / throughput, ~90 % efficiency), and
// the navigation contends with them when they overlap.
//   node tools/socket-throttle-check.mjs <chromium> <kbps> <rtt> [--legacy] [--defer]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const [chrome, kbps, rtt] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const legacy = process.argv.includes('--legacy');
const defer = process.argv.includes('--defer');
const blobs = {'/a.bin': randomBytes(1 << 20), '/b.bin': randomBytes(1 << 20)};
const page = `<!doctype html><title>pending</title><script>
const run = () => Promise.all(['/a.bin', '/b.bin'].map((u) => fetch(u, {cache: 'no-store'}).then((r) => r.arrayBuffer()))).then(() => {
  const res = performance.getEntriesByType('resource').map((e) => ({n: e.name.split('/').pop(), start: Math.round(e.startTime), ttfb: Math.round(e.responseStart - e.startTime), dur: Math.round(e.duration)}));
  const nav = performance.getEntriesByType('navigation')[0];
  document.title = JSON.stringify({nav: {ttfb: Math.round(nav.responseStart), end: Math.round(nav.responseEnd)}, res});
});
${defer ? "addEventListener('load', run);" : 'run();'}
</script><!--${'x'.repeat(200 * 1024)}-->`;
const server = createServer((req, res) => {
  const body = blobs[req.url] ?? Buffer.from(page);
  res.writeHead(200, {'content-type': blobs[req.url] ? 'application/octet-stream' : 'text/html', 'content-length': body.length, 'cache-control': 'no-store'});
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const port = server.address().port, dport = 9900 + Math.floor(Math.random() * 90);
const profile = await mkdtemp(join(tmpdir(), 'smp-sockcheck-'));
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${dport}`, 'about:blank'], {stdio: 'ignore'});
const done = async (code) => { child.kill('SIGKILL'); server.close(); await rm(profile, {recursive: true, force: true}); process.exit(code); };
setTimeout(() => { console.log('WATCHDOG'); done(2); }, 90000).unref();
let ws;
for (let i = 0; i < 200 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === 'page'); if (t) ws = new WebSocket(t.webSocketDebuggerUrl); } catch {}
  if (!ws) await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => ws.addEventListener('open', r, {once: true}));
let id = 1; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const call = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pending.set(i, {resolve, reject}); ws.send(JSON.stringify({id: i, method, params})); });
await call('Network.enable');
const cond = {latency: rtt, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8};
if (legacy) await call('Network.emulateNetworkConditions', {offline: false, ...cond});
else await call('Network.emulateNetworkConditionsByRule', {matchedNetworkConditions: [{urlPattern: '', ...cond, socketLayer: true}]});
const t = Date.now();
await call('Page.navigate', {url: `http://127.0.0.1:${port}/`});
for (;;) {
  const {result} = await call('Runtime.evaluate', {expression: 'document.title', returnByValue: true});
  if (result.value && result.value.startsWith('{')) {
    const v = JSON.parse(result.value);
    const ideal = (2 * (1 << 20)) / ((kbps * 1000) / 8) * 1000;
    console.log(`${legacy ? 'legacy CDP' : 'socket-layer'} ${kbps} kbps / ${rtt} ms${defer ? ' (fetches after load)' : ''}: nav ttfb ${v.nav.ttfb} ms, nav end ${v.nav.end} ms (200 kB alone: ~${Math.round(200 * 1024 / (kbps * 1000 / 8) * 1000)} ms + RTTs)`);
    for (const r of v.res) console.log(`  ${r.n}: start ${r.start} ms, ttfb ${r.ttfb} ms, duration ${r.dur} ms`);
    console.log(`  2 x 1 MB sharing one budget would take ~${Math.round(ideal)} ms; wall ${Date.now() - t} ms`);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
ws.close();
await done(0);
