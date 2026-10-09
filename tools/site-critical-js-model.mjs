// Models what shipping a site's critical startup JS as ONE module-declarations
// bundle would change on slow links, from runs analysed by
// site-critical-js-report.mjs.
//
//   node tools/site-critical-js-model.mjs <cpu-run-dir> [--net <throttled-run-dir>...]
//        [--hdr-external 220] [--efficiency 0.9] [--competing-kb N]
//
// <cpu-run-dir> supplies bytes, ES post-order and per-file top-level evaluation
// time at its CPU rate; each --net run (socket-layer throttled) supplies the
// bytes that competed with the critical JS and a measured last byte to
// validate against. Bandwidth-bound model, t = 0 when the startup JS is requested:
//   today:     the module graph evaluates after its last byte (ES semantics).
//   bundle:    one br11 stream in post-order; module i evaluates at
//              max(its last byte, end of module i-1).
//   flattened: one conventional bundle, assumed 3.4 % smaller than the bundle
//              (measured on the prototype's test app, not on this site).
// Link capacity = efficiency x nominal (0.9 measured with socket-layer delay);
// competing bytes (fonts, CSS, ...) arrive within the JS window in both cases.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? Number(args[args.indexOf(`--${n}`) + 1]) : d);
const netDirs = args.flatMap((a, i) => (args[i - 1] === '--net' ? [a] : []));
const load = (d) => JSON.parse(readFileSync(join(d, 'summary.json')));
const s = load(args[0]);
const hdrExternal = opt('hdr-external', 220);
const eff = opt('efficiency', 0.9);
const crit = s.files.filter((f) => f.gate <= 2).sort((a, b) => a.post - b.post);
const sum = (a, k) => a.reduce((acc, f) => acc + f[k], 0);
const served = sum(crit, 'wire'), perFileBr = sum(crit, 'br11'), oneBr = s.concatBr11;
const E = sum(crit, 'evalMs');
const kB = (n) => (n / 1024).toFixed(0);
const sec = (ms) => (ms / 1000).toFixed(2);
const nets = netDirs.map(load);
const competing = opt('competing-kb', null) != null ? opt('competing-kb') * 1024
  : nets.length ? Math.min(...nets.map((n) => Object.entries(n.linkUsage.recv).filter(([k]) => k !== 'critical JS').reduce((a, [, v]) => a + v, 0))) : 0;

console.log(`${args[0]}: cpu ${s.meta.cpu}x; ${crit.length} critical files; top-level eval ${E.toFixed(0)} ms (entry-last post-order)`);
console.log(`  bytes: served ${kB(served)} kB body | br11 per file ${kB(perFileBr)} kB | one br11 stream ${kB(oneBr)} kB | headers ~${kB(crit.length * hdrExternal)} kB at ${hdrExternal} B/response (external, speculative)`);
console.log(`  link capacity ${eff} x nominal; ${kB(competing)} kB of other bytes compete within the JS window`);

function simulate(kbps, rtt, hdrPerResp) {
  const B = (eff * kbps * 1000) / 8 / 1000; // bytes/ms
  const today = served + crit.length * hdrPerResp + competing;
  const lastToday = rtt + today / B;
  let t = 0, cum = 0;
  const bundleBytes = oneBr + 500 + competing;
  for (const f of crit) { // competing bytes spread evenly over the bundle's download
    cum += (f.br11 / perFileBr) * (oneBr + competing);
    t = Math.max(rtt + cum / B, t) + f.evalMs;
  }
  const lastBundle = rtt + bundleBytes / B;
  return {
    lastToday, evalToday: lastToday + E, lastBundle, evalBundle: Math.max(t, lastBundle),
    flat: rtt + (oneBr / 1.034 + 500 + competing) / B + E,
    precompress: (served - perFileBr) / B, context: (perFileBr - oneBr) / B, headers: (crit.length * hdrPerResp - 500) / B,
    overlap: E - (Math.max(t, lastBundle) - lastBundle),
  };
}
for (const n of nets) {
  const hdr = sum(n.files.filter((f) => f.gate <= 2), 'hdr') / crit.length;
  const r = simulate(n.meta.kbps, n.meta.rtt, hdr);
  const measured = n.linkUsage.w1 - n.linkUsage.w0;
  console.log(`  validation ${n.meta.kbps} kbps/${n.meta.rtt} ms (${kB(hdr * crit.length)} kB headers, as measured): model last byte ${sec(r.lastToday)} s after request, measured ${sec(measured)} s`);
}
console.log(`  ${'link'.padEnd(18)} today: last byte -> evaluated | bundle: last byte -> evaluated | saved: br11 + one context + headers + eval overlap = total | flattened`);
for (const [name, kbps, rtt] of [['400 kbps / 400 ms', 400, 400], ['1.6 Mbps / 150 ms', 1600, 150], ['4 Mbps / 40 ms', 4000, 40], ['20 Mbps / 40 ms', 20000, 40]]) {
  const r = simulate(kbps, rtt, hdrExternal);
  const total = r.evalToday - r.evalBundle;
  console.log(`  ${name.padEnd(18)} ${sec(r.lastToday).padStart(6)} -> ${sec(r.evalToday).padStart(6)} s     | ${sec(r.lastBundle).padStart(6)} -> ${sec(r.evalBundle).padStart(6)} s      | ${sec(r.precompress)} + ${sec(r.context)} + ${sec(r.headers)} + ${sec(r.overlap)} = ${sec(total)} s | ${sec(r.flat)} s`);
}
