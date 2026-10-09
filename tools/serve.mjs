// Static server with bandwidth + latency shaping, so the download actually
// takes seconds and streaming execution has something to overlap with.
//
//   node tools/serve.mjs --port 8080 --kbps 4000 --latency 40
//
// Routes:
//   /               -> dist/streamed      (2024 polyfill: inline specifier modules)
//   /declarations/  -> dist/declarations  (<script type="module-declarations">)
//   /baseline/      -> dist/baseline      (one module, executes at the end)
//   POST /__report  collects a run's numbers (used by tools/measure.mjs)

import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {dirname, extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PORT = Number(arg('port', 8080));
const KBPS = Number(arg('kbps', 4000)); // 0 disables shaping
const LATENCY = Number(arg('latency', 40)); // ms before the first byte
const SLICE_MS = 25; // shaping granularity

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const reports = [];

async function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  let base = 'streamed';
  for (const mode of ['baseline', 'declarations', 'streamed']) {
    if (rel === `/${mode}` || rel.startsWith(`/${mode}/`)) {
      base = mode;
      rel = rel.slice(mode.length + 1) || '/';
      break;
    }
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = join(DIST, base, normalize(rel));
  if (!full.startsWith(join(DIST, base))) return null;
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    return {full, size: info.size};
  } catch {
    return null;
  }
}

async function writeShaped(res, body) {
  if (LATENCY > 0) await sleep(LATENCY);
  if (!KBPS) {
    res.end(body);
    return;
  }
  const bytesPerSecond = (KBPS * 1000) / 8;
  const bytesPerSlice = Math.max(1024, Math.floor((bytesPerSecond * SLICE_MS) / 1000));
  const start = Date.now();
  let sent = 0;
  while (sent < body.length) {
    if (res.destroyed) return;
    const ok = res.write(body.subarray(sent, sent + bytesPerSlice));
    sent += bytesPerSlice;
    if (!ok) await new Promise((r) => res.once('drain', r));
    // Absolute schedule rather than a fixed sleep: setTimeout overshoots, and
    // a per-slice sleep lets that error accumulate into a much slower link
    // than requested.
    const due = start + (sent / bytesPerSecond) * 1000;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__report')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      reports.push(payload);
      process.stdout.write(`\n[report] ${JSON.stringify(payload)}\n`);
    } catch (err) {
      console.error('[report] bad payload', err.message);
    }
    res.writeHead(204).end();
    return;
  }

  if (req.url.startsWith('/__reports')) {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(reports));
    return;
  }

  const found = await resolveFile(req.url);
  if (!found) {
    res.writeHead(404, {'content-type': 'text/plain'}).end('not found\n');
    return;
  }

  const body = await readFile(found.full);
  res.writeHead(200, {
    'content-type': TYPES[extname(found.full)] || 'application/octet-stream',
    'content-length': String(body.length),
    // No compression and no caching: both builds must be measured on equal,
    // repeatable terms.
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await writeShaped(res, body);
});

server.listen(PORT, () => {
  console.log(
    `serving ${DIST}\n` +
      `  streamed      http://localhost:${PORT}/\n` +
      `  declarations  http://localhost:${PORT}/declarations/\n` +
      `  baseline      http://localhost:${PORT}/baseline/\n` +
      `  shaping   ${KBPS ? KBPS + ' kbps' : 'unshaped'}, ${LATENCY} ms latency\n`,
  );
});

export {server};
