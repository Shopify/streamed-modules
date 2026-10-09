// Analyses a run recorded by site-critical-js.mjs: per-file bytes, request and
// arrival times, static import graph (which files gate the startup module
// evaluations), main-thread compile, and per-file top-level evaluation time
// from the 100 us CPU profile. Writes summary.json next to the run.
//
//   node --max-old-space-size=8192 tools/site-critical-js-report.mjs <run-dir> [--top 20]

import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {brotliCompressSync, constants, gunzipSync} from 'node:zlib';

const dir = process.argv[2];
const top = Number(process.argv.includes('--top') ? process.argv[process.argv.indexOf('--top') + 1] : 20);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json')));
const net = JSON.parse(readFileSync(join(dir, 'network.json')));
const page = JSON.parse(readFileSync(join(dir, 'page.json')));
const bodies = JSON.parse(gunzipSync(readFileSync(join(dir, 'bodies.json.gz'))));
const traceRaw = JSON.parse(gunzipSync(readFileSync(join(dir, 'trace.json.gz'))));
const ev = Array.isArray(traceRaw) ? traceRaw : traceRaw.traceEvents;

// The requested URL, not page.href: the page may navigate away after loading.
const docUrl = meta.url;
const doc = net.find((r) => r.type === 'Document' && r.url === docUrl) ?? net.find((r) => r.type === 'Document');
const name = (u) => (u || '').split('/').pop().replace(/\?.*$/, '');
const kB = (n) => (n / 1024).toFixed(1);
const f0 = (n) => (n == null ? '' : n.toFixed(0));

// --- time base: trace microseconds, relative to the page's navigationStart.
const navEv = ev.filter((e) => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL === docUrl).pop();
const T0 = navEv.ts;
const pid = navEv.pid, tid = navEv.tid;
// Network clock -> trace clock, from subresources (the document's renderer-side
// ResourceSendRequest is emitted at commit, not at request time).
const byId = new Map(net.map((r) => [r.requestId, r]));
const offs = ev.filter((e) => e.name === 'ResourceSendRequest' && byId.get(e.args?.data?.requestId)?.ts && e.args.data.requestId !== doc.requestId)
  .map((e) => e.ts - byId.get(e.args.data.requestId).ts * 1e6).sort((a, b) => a - b);
const netOffset = offs.length ? offs[offs.length >> 1] : 0;
const tn = (s) => (s == null ? null : (s * 1e6 + netOffset - T0) / 1000); // network seconds -> ms since nav
const tt = (us) => (us - T0) / 1000; // trace us -> ms since nav

// --- JS files and the document.
const isJs = (r) => /javascript|ecmascript/.test(r.mimeType || '') || /\.m?js(\?|$)/.test(r.url || '');
const files = new Map();
for (const r of net) {
  if (!isJs(r) || r.failed || !r.endTs || !bodies[r.url] || files.has(r.url)) continue;
  const body = Buffer.from(bodies[r.url]);
  files.set(r.url, {
    url: r.url, name: name(r.url), decoded: body.length, wire: (r.encodedDataLength || 0) - (r.headerBytes || 0),
    hdr: r.headerBytes || 0, req: tn(r.ts), first: tn(r.chunks[0]?.[0] ?? r.endTs), end: tn(r.endTs),
    priority: r.priority, initiator: r.initiator.type + (r.initiator.hasStack ? '+stack' : ''),
    br11: brotliCompressSync(body, {params: {[constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length}}).length,
    evalMs: 0, compileMs: 0, bgParseMs: 0, imports: [], dynImports: [],
  });
}

// --- static import graph from the bodies (statement-position imports/re-exports only).
function parseImports(src, base) {
  const stat = [], dyn = [];
  const re = /(?:^|[;\n}])\s*(?:import\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s*[\w$]+\s*|\{[^}]*\}\s*)?(?:from\s*)?|export\s*(?:\*(?:\s*as\s*[\w$]+)?|\{[^}]*\})\s*from\s*)["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) stat.push(new URL(m[1], base).href);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) dyn.push(new URL(m[1], base).href);
  return {stat: [...new Set(stat)], dyn: [...new Set(dyn)]};
}
for (const f of files.values()) Object.assign(f, (({stat, dyn}) => ({imports: stat, dynImports: dyn}))(parseImports(bodies[f.url], f.url)));
// Inline module scripts in the HTML are the roots.
const html = bodies[doc.url] || '';
const inlineModules = [...html.matchAll(/<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => parseImports(m[1], doc.url));
const roots = inlineModules.flatMap((m) => m.stat);
const lazyRoots = inlineModules.flatMap((m) => m.dyn);
const order = []; // ES post-order: what a module-declarations bundle would emit
const seen = new Set();
function visit(u, gate) {
  if (seen.has(u)) return;
  seen.add(u);
  const f = files.get(u);
  if (!f) return;
  for (const d of f.imports) visit(d, gate);
  f.gate = gate; f.post = order.length; order.push(u);
}
for (const r of roots) visit(r, 1);
for (const r of lazyRoots) visit(r, 2);
for (const f of files.values()) if (!f.gate) f.gate = 3; // loaded later: dynamic import or classic script

// --- main-thread trace events.
const onMain = (e) => e.pid === pid && e.tid === tid;
const evalModules = [];
for (const e of ev) {
  if (!onMain(e) || e.ph !== 'X') continue;
  const u = e.args?.data?.url;
  if ((e.name === 'v8.compileModule' || e.name === 'v8.compile') && files.has(u)) files.get(u).compileMs += e.dur / 1000;
  if (e.name === 'v8.evaluateModule') evalModules.push({start: tt(e.ts), end: tt(e.ts + e.dur), files: new Map()});
}
for (const e of ev) {
  if (e.name === 'v8.parseOnBackground' && e.pid === pid && files.has(e.args?.data?.url)) files.get(e.args.data.url).bgParseMs += (e.dur || 0) / 1000;
}
const fcp = ev.find((e) => e.name === 'firstContentfulPaint' && e.pid === pid && e.ts > T0);
const lcps = ev.filter((e) => e.name === 'largestContentfulPaint::Candidate' && e.pid === pid && e.ts > T0);
const lcp = lcps[lcps.length - 1];

// --- CPU profile of the main thread.
const prof = ev.find((e) => e.name === 'Profile' && e.pid === pid && e.tid === tid);
const nodes = new Map();
const samples = [];
let clock = prof.args.data.startTime;
for (const e of ev) {
  if (e.name !== 'ProfileChunk' || e.pid !== pid || e.id !== prof.id) continue;
  const cp = e.args.data.cpuProfile || {};
  for (const n of cp.nodes || []) nodes.set(n.id, n);
  const deltas = e.args.data.timeDeltas || [];
  (cp.samples || []).forEach((id, i) => { clock += deltas[i]; samples.push([id, clock]); });
}
samples.sort((a, b) => a[1] - b[1]);
const rootId = [...nodes.values()].find((n) => n.callFrame.functionName === '(root)').id;
const outer = new Map();
function outermost(id) {
  if (outer.has(id)) return outer.get(id);
  let n = nodes.get(id);
  while (n.parent != null && n.parent !== rootId) n = nodes.get(n.parent);
  outer.set(id, n);
  return n;
}
const cat = new Map(); // category -> {ms, first, last}
const add = (k, ms, t) => {
  const c = cat.get(k) ?? cat.set(k, {ms: 0, first: t, last: t}).get(k);
  c.ms += ms; c.last = t;
};
let lastJs = null, lastJsT = -1e18;
for (let i = 0; i < samples.length - 1; i++) {
  const [id, ts] = samples[i];
  const ms = Math.min(samples[i + 1][1] - ts, 10000) / 1000;
  const t = tt(ts);
  const n = nodes.get(id), fn = n.callFrame.functionName;
  if (fn === '(idle)') { lastJs = null; continue; }
  if (fn === '(program)' || fn === '(root)') { add('native', ms, t); continue; }
  if (fn === '(garbage collector)') { add(lastJs && ts - lastJsT < 1000 ? lastJs : 'gc', ms, t); continue; }
  const o = outermost(id).callFrame;
  const line = o.lineNumber ?? 0, col = o.columnNumber ?? 0;
  let k;
  if (files.has(o.url) && o.functionName === '' && line === 0 && col === 0) k = `eval ${o.url}`;
  else if (o.url === doc.url && o.functionName === '') k = `inline ${line}:${col}`;
  else k = `cb ${name(o.url) || '(native)'} ${o.functionName || '(anon)'}@${line}:${col}`;
  add(k, ms, t);
  lastJs = k; lastJsT = ts;
  if (k.startsWith('eval ')) {
    const em = evalModules.find((m) => t >= m.start && t <= m.end);
    if (em) em.files.set(o.url, (em.files.get(o.url) || 0) + ms);
  }
}
for (const [k, c] of cat) if (k.startsWith('eval ')) files.get(k.slice(5)).evalMs = c.ms;
// Hydration burst: JS callbacks (not module evaluation) from the first one after
// the startup evaluations until the first 50 ms x CPU-rate gap between them.
const bigEvals = evalModules.filter((m) => m.end - m.start > 0.5);
const gatesEnd = bigEvals.length > 1 ? bigEvals[1].end : bigEvals[0]?.end;
const burst = {start: gatesEnd, end: gatesEnd, js: 0};
{
  const gap = 50 * Math.max(1, meta.cpu);
  for (let i = 0; i < samples.length - 1; i++) {
    const t = tt(samples[i][1]);
    if (t < gatesEnd) continue;
    const fn = nodes.get(samples[i][0]).callFrame.functionName;
    if (fn.startsWith('(')) continue;
    if (!burst.js) burst.start = t;
    else if (t - burst.end > gap) break;
    burst.end = t;
    burst.js += Math.min(samples[i + 1][1] - samples[i][1], 10000) / 1000;
  }
}
// --- report.
const all = [...files.values()];
const crit = all.filter((f) => f.gate <= 2);
const sum = (a, k) => a.reduce((s, f) => s + f[k], 0);
const lastCrit = Math.max(...crit.map((f) => f.end));
console.log(`${meta.url}  ${meta.chrome}  cpu ${meta.cpu}x${meta.kbps ? `  ${meta.kbps} kbps / ${meta.rtt} ms` : '  unthrottled'}${meta.mobile ? '  mobile' : ''}  (spin check ${f0(meta.spinMs)} ms)`);
console.log(`  HTML: first byte ${f0(tn(doc.chunks[0][0]))} ms, last byte ${f0(tn(doc.endTs))} ms, ${kB(doc.encodedDataLength)} kB wire / ${kB(Buffer.byteLength(html))} kB`);
console.log(`  FCP ${f0(fcp && tt(fcp.ts))} ms   LCP ${f0(lcp && tt(lcp.ts))} ms (${lcp?.args.data.type} ${lcp?.args.data.nodeName})`);
for (const [g, label] of [[1, 'gate 1: static graph of the inline module (root + route modules)'], [2, 'gate 2: entry.client, added by import()'], [3, 'later: dynamic imports / other scripts']]) {
  const a = all.filter((f) => f.gate === g);
  if (!a.length) continue;
  console.log(`  ${label}\n    ${a.length} files, ${kB(sum(a, 'decoded'))} kB decoded, ${kB(sum(a, 'wire'))} kB body + ${kB(sum(a, 'hdr'))} kB headers on the wire, br11 per file ${kB(sum(a, 'br11'))} kB` +
    `\n    requested ${f0(Math.min(...a.map((f) => f.req)))}-${f0(Math.max(...a.map((f) => f.req)))} ms, last byte ${f0(Math.max(...a.map((f) => f.end)))} ms; top-level eval ${f0(sum(a, 'evalMs'))} ms, main-thread compile ${f0(sum(a, 'compileMs'))} ms`);
}
const concat = brotliCompressSync(Buffer.concat(order.map((u) => Buffer.from(bodies[u]))), {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length;
console.log(`  critical JS as ONE br11 stream (post-order): ${kB(concat)} kB vs ${kB(sum(crit, 'br11'))} kB per file (${(100 * (1 - concat / sum(crit, 'br11'))).toFixed(1)}% smaller); served: ${kB(sum(crit, 'wire'))} kB body + ${kB(sum(crit, 'hdr'))} kB headers`);
console.log(`  v8.evaluateModule on the main thread:`);
for (const m of evalModules.filter((m) => m.end - m.start > 0.5)) {
  const fs = [...m.files.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`    ${f0(m.start)}-${f0(m.end)} ms (${(m.end - m.start).toFixed(1)} ms): ${fs.length} files evaluated; biggest ${fs.slice(0, 3).map(([u, ms]) => `${name(u)} ${ms.toFixed(1)}`).join(', ')}`);
}
const totals = {};
for (const [k, c] of cat) { const g = k.split(' ')[0]; totals[g] = (totals[g] || 0) + c.ms; }
console.log(`  main-thread time by kind (whole run): ${Object.entries(totals).map(([k, v]) => `${k} ${f0(v)} ms`).join(', ')}`);
console.log(`  first JS burst after the startup evaluations (hydration): ${f0(burst.start)}-${f0(burst.end)} ms, ${f0(burst.js)} ms of JS`);
console.log(`  background (worker) parse of critical JS: ${f0(sum(crit, 'bgParseMs'))} ms`);
console.log(`  top callbacks (outermost frame), ms and time range:`);
for (const [k, c] of [...cat].filter(([k]) => !k.startsWith('eval ')).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)) console.log(`    ${f0(c.ms).padStart(5)}  ${f0(c.first)}-${f0(c.last)}  ${k}`);
// Link usage while the critical JS downloads (body bytes from Network.dataReceived).
const w0 = Math.min(...crit.map((f) => f.req));
const recv = {};
const critUrls = new Set(crit.map((f) => f.url));
const critChunks = [];
for (const r of net) {
  for (const [ts, enc] of r.chunks || []) {
    const t = tn(ts);
    if (t < w0 || t > lastCrit) continue;
    const k = critUrls.has(r.url) ? 'critical JS' : r.type;
    recv[k] = (recv[k] || 0) + enc;
    if (critUrls.has(r.url)) critChunks.push([t, enc]);
  }
}
critChunks.sort((a, b) => a[0] - b[0]);
const critTotal = critChunks.reduce((a, c) => a + c[1], 0);
const when = (q) => { let acc = 0; for (const [t, b] of critChunks) { acc += b; if (acc >= q * critTotal) return t; } return null; };
const allRecv = Object.values(recv).reduce((a, b) => a + b, 0);
const winS = (lastCrit - w0) / 1000;
console.log(`  while the critical JS downloads (${f0(w0)}-${f0(lastCrit)} ms): ${kB(allRecv)} kB of bodies received, ${f0((allRecv * 8) / 1000 / winS)} kbps` +
  (meta.kbps ? ` (link ${meta.kbps} kbps)` : '') + `; critical JS ${f0((100 * (recv['critical JS'] || 0)) / allRecv)}% of it at ${f0(((recv['critical JS'] || 0) * 8) / 1000 / winS)} kbps`);
console.log(`    by type: ${Object.entries(recv).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${kB(v)} kB`).join(', ')}`);
console.log(`    critical JS bytes arrived: 50% at ${f0(when(0.5))} ms, 90% at ${f0(when(0.9))} ms, 100% at ${f0(when(1))} ms`);
console.log(`  critical files by decoded size (last critical byte at ${f0(lastCrit)} ms):`);
console.log(`    ${'file'.padEnd(44)} gate  decoded   body  hdrB  br11   req    end   eval  compile`);
for (const f of crit.slice().sort((a, b) => b.decoded - a.decoded).slice(0, top)) {
  console.log(`    ${f.name.slice(0, 44).padEnd(44)} ${String(f.gate).padStart(3)} ${kB(f.decoded).padStart(8)} ${kB(f.wire).padStart(6)} ${String(f.hdr).padStart(5)} ${kB(f.br11).padStart(5)} ${f0(f.req).padStart(5)} ${f0(f.end).padStart(6)} ${f.evalMs.toFixed(1).padStart(6)} ${f.compileMs.toFixed(1).padStart(8)}`);
}
console.log(`  critical files by top-level eval time:`);
for (const f of crit.slice().sort((a, b) => b.evalMs - a.evalMs).slice(0, 12)) console.log(`    ${f.evalMs.toFixed(1).padStart(6)} ms  ${kB(f.decoded).padStart(7)} kB  post#${f.post}  ${f.name}`);

writeFileSync(join(dir, 'summary.json'), JSON.stringify({
  meta, burst, netOffset, linkUsage: {w0, w1: lastCrit, recv, p50: when(0.5), p90: when(0.9)}, fcp: fcp && tt(fcp.ts), lcp: lcp && tt(lcp.ts), html: {first: tn(doc.chunks[0][0]), end: tn(doc.endTs), wire: doc.encodedDataLength},
  evalModules: evalModules.map((m) => ({start: m.start, end: m.end, files: m.files.size})),
  categories: Object.fromEntries([...cat].map(([k, c]) => [k, c])), concatBr11: concat,
  files: all.map(({url, name, decoded, wire, hdr, br11, req, first, end, gate, post, evalMs, compileMs, bgParseMs, imports}) => ({url, name, decoded, wire, hdr, br11, req, first, end, gate, post, evalMs, compileMs, bgParseMs, imports})),
}, null, 1));
