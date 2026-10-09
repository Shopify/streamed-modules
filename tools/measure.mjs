// Runs each build N times in the patched Chromium and prints a comparison.
//
//   node tools/measure.mjs --runs 3 --kbps 4000 --latency 40 \
//     [--modes declarations,streamed,baseline] [--chrome /path/to/Chromium]
//
// The page posts its own numbers back to the server (see src/main.jsx), so this
// needs no CDP client.

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const RUNS = Number(arg('runs', 3));
const PORT = Number(arg('port', 8099));
const KBPS = arg('kbps', '4000');
const LATENCY = arg('latency', '40');
const MODES = arg('modes', 'declarations,streamed,baseline').split(',');
const CHROME = arg('chrome', process.env.CHROME);
if (!CHROME) {
  console.error('Pass --chrome <path to a Chromium built with CL 5649434>, or set CHROME.');
  process.exit(2);
}

process.argv.push('--port', String(PORT), '--kbps', String(KBPS), '--latency', String(LATENCY));
const {server, reports} = await import('./serve.mjs');
await new Promise((r) => setTimeout(r, 300));

async function run(url) {
  const before = reports.length;
  const profile = await mkdtemp(join(tmpdir(), 'smp-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--enable-blink-features=ModuleDeclarations',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      '--window-size=1400,900',
      url,
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));

  const result = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(null), 180000);
    const poll = setInterval(() => {
      if (reports.length > before) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(reports[reports.length - 1]);
      }
    }, 100);
    child.on('exit', () => {
      if (reports.length <= before) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(null);
      }
    });
  });

  child.kill('SIGKILL');
  await rm(profile, {recursive: true, force: true});
  if (!result) {
    const errs = stderr.join('').split('\n').filter((l) => /CONSOLE|FATAL/.test(l));
    throw new Error(`no report from ${url}\n${errs.slice(0, 8).join('\n')}`);
  }
  return result;
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const ms = (v) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(0)} ms`);

const urlFor = (mode) =>
  mode === 'streamed'
    ? `http://localhost:${PORT}/?report=1`
    : `http://localhost:${PORT}/${mode}/?report=1`;

const collected = {};
for (const mode of MODES) {
  collected[mode] = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`\rrunning ${mode} ${i + 1}/${RUNS}   `);
    collected[mode].push(await run(urlFor(mode)));
  }
}
process.stdout.write('\r' + ' '.repeat(40) + '\r');

const COL = 15;
const header = pad('milestone', 26) + MODES.map((m) => num(m, COL)).join('');
console.log(`\n${KBPS} kbps, ${LATENCY} ms latency, median of ${RUNS} runs\n`);
console.log(header);
console.log('-'.repeat(header.length));

const row = (label, pick) => {
  const cells = MODES.map((mode) => {
    const values = collected[mode].map(pick).filter((v) => v != null && !Number.isNaN(v));
    return num(values.length ? ms(median(values)) : '—', COL);
  });
  console.log(pad(label, 26) + cells.join(''));
};

row('html parsed', (r) => r.marks.htmlParsed);
row('bundle response start', (r) => r.download?.responseStart);
row('first module evaluated', (r) => r.firstModuleExec);
row('bundle response end', (r) => r.download?.responseEnd);
row('last module evaluated', (r) => r.lastModuleExec);
row('entry module evaluated', (r) => r.marks.entryEvaluated);
row('painted', (r) => r.marks.rendered);
console.log('-'.repeat(header.length));
row('body transfer time', (r) => r.download?.bodyMs);
row('work after last byte', (r) =>
  r.download ? r.marks.rendered - r.download.responseEnd : null,
);
console.log(
  pad('bytes transferred', 26) +
    MODES.map((mode) =>
      num(median(collected[mode].map((r) => r.download?.transferSize ?? NaN)) || '—', COL),
    ).join(''),
);
console.log(
  pad('bundle modules', 26) +
    MODES.map((mode) => num(median(collected[mode].map((r) => r.modules || 1)), COL)).join(''),
);

if (MODES.includes('baseline')) {
  console.log('');
  const basePaint = median(collected.baseline.map((r) => r.marks.rendered));
  for (const mode of MODES.filter((m) => m !== 'baseline')) {
    const paint = median(collected[mode].map((r) => r.marks.rendered));
    console.log(`${pad(mode, 14)} paints ${ms(basePaint - paint)} before baseline`);
  }
}

server.close();
process.exit(0);
