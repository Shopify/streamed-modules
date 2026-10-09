// Builds the cases in tests/cases.mjs, serves them, loads each in the patched
// Chromium and checks document.title. Needs --enable-blink-features=
// ModuleDeclarations, which the launcher passes.
//
//   node tests/run.mjs [--chrome /path/to/Chromium]

import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';
import {CASES, OUT, writeCases} from './cases.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const CHROME = arg('chrome', process.env.CHROME);
if (!CHROME) {
  console.error('Pass --chrome <path to a Chromium built with CL 5649434>, or set CHROME.');
  process.exit(2);
}
const PORT = Number(arg('port', 8127));
const TIMEOUT = Number(arg('timeout', 20000));

writeCases();

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};
const server = createServer(async (req, res) => {
  try {
    const body = await readFile(join(OUT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'content-type': TYPES[extname(req.url)] || 'text/plain', 'cache-control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT);

async function titleOf(url) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = await mkdtemp(join(tmpdir(), 'smp-test-'));
  const child = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
     '--enable-blink-features=ModuleDeclarations', `--user-data-dir=${profile}`,
     `--remote-debugging-port=${port}`, url],
    {stdio: 'ignore'},
  );
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page) {
        last = page.title;
        // Settled: a result, or the load/error event added its suffix.
        if (/^(DONE|ERROR)/.test(last) && (last.includes('[load]') || /^ERROR/.test(last) || last.includes('orphanRan'))) break;
      }
    } catch {}
  }
  child.kill('SIGKILL');
  // Chromium may still be writing to its profile as it exits.
  await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  return last;
}

let failed = 0;
for (const c of CASES) {
  const title = await titleOf(`http://localhost:${PORT}/${c.name}.html`);
  const ok = title != null && title.startsWith(c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(9)} ${JSON.stringify(title)}${ok ? '' : `\n      expected prefix ${JSON.stringify(c.expect)}`}`);
}
server.close();
console.log(failed ? `\n${failed} failed` : `\nall ${CASES.length} passed`);
process.exit(failed ? 1 : 0);
