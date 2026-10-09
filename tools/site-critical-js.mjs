// Records a live site's startup JavaScript in enough detail to estimate what
// streamed module execution could save there: per-file bytes (wire, headers,
// decoded), when each file was requested, first/last byte, who requested it,
// the bodies, in-page paint/LCP/LoAF data, and a trace with a 100 us CPU
// profile of the renderer main thread (per-file top-level evaluation time).
//
//   node tools/site-critical-js.mjs https://example.com/ --out /tmp/run-1x \
//     [--cpu 4] [--kbps 1600 --rtt 150 --up-kbps 750 [--socket]] [--mobile] \
//     [--disable-quic] [--settle 15000] [--chrome /path]
//
// Network shaping: by default CDP's legacy URLLoader throttling (per-request
// latency, throughput shared round-robin per request, priority-blind). With
// --socket, socket-layer delay (Network.emulateNetworkConditionsByRule with
// socketLayer: true; needs CLs 7703417 + 7702978): RTT on connect and every
// round trip, one bandwidth budget shared by all connections of the session.
// Analyse with site-critical-js-report.mjs.

import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const url = process.argv[2];
const out = arg('out', null);
if (!url || !out) {
  console.error('usage: site-critical-js.mjs <url> --out <dir> [--cpu N] [--kbps K --rtt MS] [--mobile]');
  process.exit(1);
}
const chrome = arg('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const settle = Number(arg('settle', 15000));
const cpu = Number(arg('cpu', 1));
const kbps = Number(arg('kbps', 0));
const rtt = Number(arg('rtt', 0));
const upKbps = Number(arg('up-kbps', kbps ? Math.max(kbps / 2, 256) : 0));
const mobile = flag('mobile');
const socketLayer = flag('socket');
const port = 9200 + Math.floor(Math.random() * 500);

const categories = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  '__metadata',
];

const profile = await mkdtemp(join(tmpdir(), 'smp-critical-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1400,900',
  ...(flag('disable-quic') ? ['--disable-quic'] : []), 'about:blank',
], {stdio: 'ignore'});
const cleanup = async (code) => {
  try { child.kill('SIGKILL'); } catch {}
  await rm(profile, {recursive: true, force: true});
  process.exit(code);
};
setTimeout(() => { console.error('WATCHDOG'); cleanup(2); }, settle + 120000).unref();

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
let closing = false;
ws.addEventListener('close', (e) => { if (!closing) { console.error('CDP socket closed', e.code, e.reason); cleanup(3); } });
ws.addEventListener('error', (e) => console.error('CDP socket error', e.message ?? e));

let nextId = 1;
const pending = new Map();
const listeners = new Map();
const reqs = new Map();
const req = (id) => reqs.get(id) ?? reqs.set(id, {requestId: id, chunks: []}).get(id);
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  const p = m.params;
  switch (m.method) {
    case 'Network.requestWillBeSent': {
      const r = req(p.requestId);
      if (p.redirectResponse) r.redirects = (r.redirects || 0) + 1;
      const init = p.initiator || {};
      const top = init.stack?.callFrames?.[0];
      Object.assign(r, {
        url: p.request.url, type: p.type, priority: p.request.initialPriority, ts: p.timestamp,
        wallTime: p.wallTime, frameId: p.frameId,
        initiator: {type: init.type, url: init.url ?? top?.url, line: init.lineNumber ?? top?.lineNumber,
          fn: top?.functionName, hasStack: !!init.stack, requestId: init.requestId},
      });
      break;
    }
    case 'Network.requestServedFromCache': req(p.requestId).memoryCache = true; break;
    case 'Network.responseReceived': {
      const r = req(p.requestId), res = p.response;
      const h = Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      Object.assign(r, {
        status: res.status, protocol: res.protocol, mimeType: res.mimeType, respTs: p.timestamp,
        headerBytes: res.encodedDataLength, fromDiskCache: res.fromDiskCache, timing: res.timing,
        contentEncoding: h['content-encoding'], cacheStatus: h['cf-cache-status'] || h['x-cache'] || null,
        server: h.server, contentLength: h['content-length'] ? Number(h['content-length']) : null,
      });
      break;
    }
    case 'Network.dataReceived': {
      const r = req(p.requestId);
      r.chunks.push([p.timestamp, p.encodedDataLength, p.dataLength]);
      break;
    }
    case 'Network.loadingFinished': Object.assign(req(p.requestId), {endTs: p.timestamp, encodedDataLength: p.encodedDataLength}); break;
    case 'Network.loadingFailed': Object.assign(req(p.requestId), {endTs: p.timestamp, failed: p.errorText, canceled: p.canceled}); break;
  }
  for (const fn of listeners.get(m.method) || []) fn(p);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, {resolve, reject});
  ws.send(JSON.stringify({id, method, params}));
});
const once = (method) => new Promise((resolve) => {
  const fns = listeners.get(method) || [];
  fns.push(resolve); listeners.set(method, fns);
});

const version = await call('Browser.getVersion');
await call('Network.enable', {maxResourceBufferSize: 200 * 1024 * 1024, maxTotalBufferSize: 600 * 1024 * 1024});
await call('Network.setCacheDisabled', {cacheDisabled: false});
await call('Page.enable');
await call('Runtime.enable');
// Buffered observers from the first script on: LCP candidates and LoAFs with
// script attribution.
await call('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
  const s = window.__smp = {lcp: [], loaf: []};
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp.push({t: e.startTime, size: e.size, url: e.url, el: e.element ? e.element.tagName + (e.element.id ? '#' + e.element.id : '') : null, renderTime: e.renderTime, loadTime: e.loadTime}); }).observe({type: 'largest-contentful-paint', buffered: true}); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) s.loaf.push({t: e.startTime, d: e.duration, block: e.blockingDuration, scripts: e.scripts.map((x) => ({inv: x.invoker, type: x.invokerType, src: x.sourceURL, fn: x.sourceFunctionName, start: x.startTime, exec: x.executionStart, d: x.duration, fsl: x.forcedStyleAndLayoutDuration}))}); }).observe({type: 'long-animation-frame', buffered: true}); } catch {}
})();`});
if (mobile) {
  await call('Emulation.setDeviceMetricsOverride', {width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true});
  await call('Emulation.setTouchEmulationEnabled', {enabled: true});
  const major = version.product.split('/')[1].split('.')[0];
  await call('Emulation.setUserAgentOverride', {userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`});
}
if (cpu > 1) await call('Emulation.setCPUThrottlingRate', {rate: cpu});
if (kbps && socketLayer) {
  await call('Network.emulateNetworkConditionsByRule', {matchedNetworkConditions: [{
    urlPattern: '', latency: rtt, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (upKbps * 1000) / 8, socketLayer: true,
  }]});
} else if (kbps) {
  await call('Network.emulateNetworkConditions', {
    offline: false, latency: rtt, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (upKbps * 1000) / 8,
  });
}

await call('Tracing.start', {transferMode: 'ReturnAsStream', traceConfig: {recordMode: 'recordAsMuchAsPossible', includedCategories: categories}});
const t0 = Date.now();
await call('Page.navigate', {url});
await new Promise((r) => setTimeout(r, settle));

// Check the CPU throttle is really applied to the page's renderer.
const spin = await call('Runtime.evaluate', {returnByValue: true, expression: `(() => { const s = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += i % 7; return performance.now() - s; })()`});
const page = await call('Runtime.evaluate', {returnByValue: true, expression: `(() => {
  const nav = performance.getEntriesByType('navigation')[0]?.toJSON();
  return {href: location.href, title: document.title, nav, timeOrigin: performance.timeOrigin,
    paint: performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]),
    smp: window.__smp, ua: navigator.userAgent};
})()`});

const traceDone = once('Tracing.tracingComplete');
await call('Tracing.end');
const {stream} = await traceDone;
const parts = [];
for (;;) {
  const r = await call('IO.read', {handle: stream, size: 256 << 10});
  parts.push(r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data));
  if (r.eof) break;
}
await call('IO.close', {handle: stream});

const bodies = {};
for (const r of reqs.values()) {
  const isJs = /javascript|ecmascript/.test(r.mimeType || '') || /\.m?js(\?|$)/.test(r.url || '');
  if (!(isJs || r.type === 'Document') || r.failed || !r.endTs) continue;
  try {
    const {body, base64Encoded} = await call('Network.getResponseBody', {requestId: r.requestId});
    bodies[r.url] = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  } catch {}
}

await mkdir(out, {recursive: true});
const meta = {url, chrome: version.product, cpu, kbps, rtt, upKbps, socketLayer, disableQuic: flag('disable-quic'), mobile, settle, startedAt: new Date(t0).toISOString(),
  spinMs: spin.result.value};
await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 1));
await writeFile(join(out, 'network.json'), JSON.stringify([...reqs.values()]));
await writeFile(join(out, 'page.json'), JSON.stringify(page.result.value, null, 1));
await writeFile(join(out, 'bodies.json.gz'), gzipSync(JSON.stringify(bodies)));
await writeFile(join(out, 'trace.json.gz'), gzipSync(Buffer.concat(parts)));
console.log(`${out}: ${reqs.size} requests, ${Object.keys(bodies).length} bodies, trace ${(Buffer.concat(parts).length / 1e6).toFixed(1)} MB, spin ${spin.result.value.toFixed(0)} ms, ${meta.chrome}`);
closing = true;
ws.close();
await cleanup(0);
