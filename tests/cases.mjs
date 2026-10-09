// Hand-built module-declarations bundles that exercise the loader's semantics
// independently of the app. `node tests/run.mjs` builds and runs them.
//
// Each case is {name, modules: [[name, body, flags?]], entry, extra?, expect}
// where `expect` is the prefix document.title must end up with.

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OUT = join(__dirname, 'out');

export const CASES = [
  {
    name: 'ok',
    // Three chained modules; the last writes the result. Checks bare-specifier
    // resolution within the bundle, order, import.meta.url and the load event.
    modules: [
      ['m0', `export const x = 1;\nglobalThis.__order = ['m0'];`],
      ['m1', `import {x} from 'm0';\nexport const y = x + 1;\nglobalThis.__order.push('m1');`],
      ['m2', `import {y} from 'm1';\nglobalThis.__order.push('m2');\ndocument.title = 'DONE y=' + y + ' order=' + globalThis.__order.join(',') + ' meta=' + import.meta.url.split('/').pop();`],
    ],
    entry: 'm2',
    expect: 'DONE y=2 order=m0,m1,m2 meta=ok.js#m2 [load]',
  },
  {
    name: 'throws',
    // The second module throws: the third must not run, `error` must fire.
    modules: [
      ['a', `globalThis.__ran = ['a'];`],
      ['b', `import 'a'; globalThis.__ran.push('b'); throw new Error('boom in b');`],
      ['c', `import 'b'; globalThis.__ran.push('c'); document.title = 'SHOULD NOT HAPPEN';`],
    ],
    entry: 'c',
    expect: 'ERROR a,b',
  },
  {
    name: 'utf8',
    // Non-ASCII bodies: the manifest lengths are UTF-8 byte lengths.
    modules: [
      ['u0', `export const s = 'héllo — 日本語 ✓';`],
      ['u1', `import {s} from 'u0'; document.title = 'DONE ' + s + ' len=' + s.length;`],
    ],
    entry: 'u1',
    expect: 'DONE héllo — 日本語 ✓ len=13 [load]',
  },
  {
    name: 'cycle',
    // E -> A -> {B, C}; B -> A. ES order from E is B, C, A, E. Emitted in
    // post-order [B, C, A, E] with a link group over [B, C, A].
    modules: [
      ['B', `import {fromA} from 'A';\nglobalThis.__o = ['B'];\nexport const fromB = () => 'b+' + fromA();`],
      ['C', `globalThis.__o.push('C');\nexport const c = 'c';`],
      ['A', `import {fromB} from 'B';\nimport {c} from 'C';\nglobalThis.__o.push('A');\nexport const fromA = () => 'a';\nexport const viaB = fromB();\nexport const cc = c;`],
      ['E', `import {viaB, cc} from 'A';\nglobalThis.__o.push('E');\ndocument.title = 'DONE order=' + globalThis.__o.join(',') + ' viaB=' + viaB + ' cc=' + cc;`],
    ],
    entry: 'E',
    extra: {groups: [[0, 3]]},
    expect: 'DONE order=B,C,A,E viaB=b+a cc=c [load]',
  },
  {
    name: 'lazy',
    // main import()s a lazy module declared AFTER it, which imports another
    // lazy module. A lazy module nothing imports must never run.
    modules: [
      ['base', `export const base = 'base'; globalThis.__ran = ['base'];`],
      ['main', `import {base} from 'base';\nglobalThis.__ran.push('main');\nglobalThis.__p = import('later').then(m => { document.title = 'DONE ' + m.value + ' ran=' + globalThis.__ran.join(',') + ' orphanRan=' + !!globalThis.__orphan; });`],
      ['helper', `export const h = 'helper'; globalThis.__ran.push('helper');`, 1],
      ['later', `import {h} from 'helper';\nimport {base} from 'base';\nglobalThis.__ran.push('later');\nexport const value = 'later(' + h + ',' + base + ')';`, 1],
      ['orphan', `globalThis.__orphan = true; globalThis.__ran.push('ORPHAN');`, 1],
    ],
    entry: 'main',
    expect: 'DONE later(helper,base) ran=base,main,helper,later orphanRan=false',
  },
  {
    name: 'badorder',
    // A forward static import with no link group: must fail with a diagnostic
    // (and `error`), not crash.
    modules: [
      ['X', `import {y} from 'Y'; export const x = 1;`],
      ['Y', `export const y = 2; document.title = 'SHOULD NOT HAPPEN';`],
    ],
    entry: 'Y',
    expect: 'ERROR',
  },
];

export function bundleSource({modules, entry, extra = {}}) {
  const manifest = {
    v: 1,
    entry,
    modules: modules.map(([n, body, flags]) =>
      flags ? [n, Buffer.byteLength(body), flags] : [n, Buffer.byteLength(body)],
    ),
    ...extra,
  };
  let out = `//# module-declarations ${JSON.stringify(manifest)}\n`;
  for (const [n, body] of modules) out += `module ${n} {\n${body}\n}\n`;
  return out;
}

export function writeCases() {
  mkdirSync(OUT, {recursive: true});
  for (const c of CASES) {
    writeFileSync(join(OUT, `${c.name}.js`), bundleSource(c));
    writeFileSync(
      join(OUT, `${c.name}.html`),
      `<!DOCTYPE html><html><head><title>pending</title></head><body>
<script>
  document.title = HTMLScriptElement.supports('module-declarations') ? 'supported' : 'UNSUPPORTED';
  const s = document.createElement('script');
  s.type = 'module-declarations'; s.src = './${c.name}.js';
  s.onload = () => { document.title += ' [load]'; };
  s.onerror = () => { document.title = 'ERROR ' + (globalThis.__ran || []).join(',') + ' ' + document.title; };
  document.head.append(s);
</script></body></html>`,
    );
  }
  return CASES.map((c) => c.name);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${writeCases().join(', ')} into ${OUT}`);
}
