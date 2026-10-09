// Loads a URL and reports document.title over time, read from the DevTools
// HTTP endpoint (/json/list) rather than Runtime.evaluate - so it works even
// when CDP script evaluation is gated by the page's state.
//
//   node tools/title-probe.mjs <url> [timeoutMs]

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.argv[2];
const timeout = Number(process.argv[3] || 30000);
const chrome = process.env.CHROME;
if (!chrome) {
  console.error('Set CHROME to the path of a Chromium built with CL 5649434.');
  process.exit(2);
}
const port = 9500 + Math.floor(Math.random() * 300);

const profile = await mkdtemp(join(tmpdir(), 'smp-title-'));
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
    url,
  ],
  {stdio: ['ignore', 'ignore', 'pipe']},
);
const stderr = [];
child.stderr.on('data', (d) => stderr.push(d.toString()));

const t0 = Date.now();
let last = null;
let sawTarget = false;

while (Date.now() - t0 < timeout) {
  await new Promise((r) => setTimeout(r, 250));
  let pages = null;
  try {
    pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    continue;
  }
  const page = pages.find((t) => t.type === 'page' && t.url.startsWith('http'));
  if (!page) continue;
  sawTarget = true;
  if (page.title !== last) {
    console.log(`t=${((Date.now() - t0) / 1000).toFixed(2)}s  ${page.title}`);
    last = page.title;
  }
  if (String(page.title).startsWith('DONE')) break;
}

if (!sawTarget) console.log('never saw an http page target');
if (!String(last).startsWith('DONE')) {
  console.log(`NOT DONE after ${((Date.now() - t0) / 1000).toFixed(1)}s (last title: ${last})`);
  const errs = stderr.join('').split('\n').filter((l) => /CONSOLE|Uncaught|ERROR:/.test(l));
  for (const e of errs.slice(0, 10)) console.log('  ' + e.slice(0, 200));
}

child.kill('SIGKILL');
await rm(profile, {recursive: true, force: true});
process.exit(0);
