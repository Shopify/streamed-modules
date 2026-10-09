// Listen-only CDP client: navigates and prints console output, exceptions, log
// entries and lifecycle events. Never calls Runtime.evaluate, so it keeps
// working when script evaluation from the debugger is gated.
//
//   node tools/listen.mjs <url> [seconds]

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.argv[2];
const seconds = Number(process.argv[3] || 15);
const chrome = process.env.CHROME;
if (!chrome) {
  console.error('Set CHROME to the path of a Chromium built with CL 5649434.');
  process.exit(2);
}
const port = 9700 + Math.floor(Math.random() * 200);

const profile = await mkdtemp(join(tmpdir(), 'smp-listen-'));
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
const fire = (method, params = {}) => ws.send(JSON.stringify({id: id++, method, params}));

const t0 = Date.now();
const at = () => `t=${((Date.now() - t0) / 1000).toFixed(2)}s`;

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  switch (m.method) {
    case 'Runtime.consoleAPICalled':
      console.log(
        `${at()} [console.${m.params.type}] ` +
          m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
      );
      break;
    case 'Runtime.exceptionThrown': {
      const d = m.params.exceptionDetails;
      console.log(
        `${at()} [EXCEPTION] ${d.text} :: ` +
          `${(d.exception?.description ?? '').split('\n').slice(0, 3).join(' | ')} ` +
          `@${d.url ?? '(inline)'}:${d.lineNumber}`,
      );
      break;
    }
    case 'Log.entryAdded': {
      const entry = m.params.entry;
      console.log(
        `${at()} [log.${entry.level}] ${entry.text.slice(0, 300)}` +
          (entry.url ? ` @${entry.url}` : ''),
      );
      break;
    }
    case 'Page.loadEventFired':
      console.log(`${at()} [load event]`);
      break;
    case 'Page.domContentEventFired':
      console.log(`${at()} [DOMContentLoaded]`);
      break;
    case 'Network.loadingFailed':
      console.log(
        `${at()} [net FAILED] ${m.params.errorText} ${m.params.type} ` +
          `(id ${m.params.requestId})`,
      );
      break;
    case 'Network.responseReceived':
      console.log(
        `${at()} [net ←] ${m.params.response.status} ` +
          `${m.params.response.url.slice(0, 100)}`,
      );
      break;
    case 'Page.frameStoppedLoading':
      console.log(`${at()} [frame stopped loading]`);
      break;
    case 'Page.requestWillBeSent':
    case 'Network.requestWillBeSent':
      if (!m.params.request.url.startsWith('data:')) {
        console.log(`${at()} [net →] ${m.params.request.url.slice(0, 120)}`);
      }
      break;
    default:
      break;
  }
});

fire('Runtime.enable');
fire('Log.enable');
fire('Page.enable');
fire('Network.enable');
await new Promise((r) => setTimeout(r, 300));
console.log(`${at()} navigating to ${url}`);
fire('Page.navigate', {url});

await new Promise((r) => setTimeout(r, seconds * 1000));
console.log(`${at()} done listening`);
ws.close();
child.kill('SIGKILL');
await rm(profile, {recursive: true, force: true});
process.exit(0);
