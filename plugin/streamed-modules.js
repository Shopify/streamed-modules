// Vite/Rollup plugin with three output modes for the same app:
//
//   baseline      one flattened module, the conventional bundle.
//   streamed      the 2024 polyfill: a concatenation of separate modules plus a
//                 byte map, executed by loader/streamed-loader.js via
//                 <script type=module specifier> (Chromium CL 5649434). Modules
//                 are compiled on the main thread at insertion - which is why
//                 this mode loses parsing parallelism.
//   declarations  a form of TC39 module declarations
//                 (https://github.com/tc39/proposal-module-declarations),
//                 consumed natively by <script type="module-declarations">
//                 in the patched Chromium: one response, many named modules,
//                 each compiled on a V8 worker thread as its bytes arrive and
//                 evaluated as soon as it and everything before it is ready.
//
// How the module graph is kept separable
// --------------------------------------
// A normal ES bundle is one module: Rollup flattens every input module into a
// single scope and renames bindings, which destroys the boundaries. (That was
// the wall the 2024 prototype hit: "the bundler strips all the module
// dependencies".) Both non-baseline modes keep `output.preserveModules: true`,
// so Rollup emits one chunk per input module with real import/export
// statements between them, and this plugin rewrites the relative specifiers to
// short bare names (`m0`, `m1`, ...) before concatenating.
//
// Order
// -----
// `streamed` uses Tarjan SCC order (any dependencies-first order works, the
// browser links lazily). `declarations` uses the entry's DFS post-order over
// static imports - the exact order ES would evaluate the graph in - so that
// evaluating modules in file order as they arrive is observably identical to
// evaluating the entry after the whole file arrived. Two refinements:
//
//   * A cyclic import becomes a *link group* in the manifest: the post-order
//     range from the cycle's first member to its DFS root. Blink links and
//     evaluates the group as one unit, rooted at the last member, once all of
//     it has compiled - V8 then produces the ES order.
//   * A module reachable only through dynamic import() is emitted after the
//     eager modules and flagged *lazy*: compiled and registered, but only
//     evaluated when something import()s it. Blink pre-registers every
//     declared module in the module map, so a forward import() waits for the
//     bundle instead of fetching the URL.
//
// Modules unreachable from the entry (by any edge) are dropped.

import {readFileSync} from 'node:fs';
import {dirname, join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  mode: 'streamed', // 'baseline' | 'streamed' | 'declarations'
  bundleName: 'bundle.js',
  // streamed mode only. Where specifiers resolve to; never fetched, only an
  // identity in the module map. Relative so the build can be served under any
  // path prefix.
  virtualBase: './v/',
  // streamed mode only. Real directory for the cyclic-SCC fallback files.
  fallbackDir: 'cyclic/',
  instrument: true,
  title: 'Streamed Modules',
};

// --------------------------------------------------------------------- graph

/** Tarjan's SCC. Emits components in reverse topological order. */
function stronglyConnectedComponents(nodes, edgesOf) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [{node: root, edges: edgesOf(root), i: 0}];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.edges.length) {
        const next = frame.edges[frame.i++];
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({node: next, edges: edgesOf(next), i: 0});
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }
      work.pop();
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let popped;
        do {
          popped = stack.pop();
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        out.push(component);
      }
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
    }
  }
  return out;
}

/**
 * ES evaluation order: DFS post-order from the entry following static imports
 * in source order. Returns {order, cycles} where cycles lists back-edges.
 */
function evaluationOrder(entryFile, staticImportsOf) {
  const order = [];
  const state = new Map(); // file -> 'visiting' | 'done'
  const cycles = [];
  const work = [{file: entryFile, deps: staticImportsOf(entryFile), i: 0}];
  state.set(entryFile, 'visiting');
  while (work.length) {
    const frame = work[work.length - 1];
    if (frame.i < frame.deps.length) {
      const dep = frame.deps[frame.i++];
      const s = state.get(dep);
      if (s === 'visiting') cycles.push([frame.file, dep]);
      if (s) continue;
      state.set(dep, 'visiting');
      work.push({file: dep, deps: staticImportsOf(dep), i: 0});
      continue;
    }
    work.pop();
    state.set(frame.file, 'done');
    order.push(frame.file);
  }
  return {order, cycles};
}

/**
 * Post-order over `edgesOf` starting from each of `roots`, skipping anything in
 * `skip` (already emitted). Used for the lazy tail: the subtrees of dynamic
 * import targets, dependencies first.
 */
function appendPostOrder(roots, edgesOf, skip) {
  const out = [];
  const state = new Map();
  for (const root of roots) {
    if (skip.has(root) || state.has(root)) continue;
    const work = [{file: root, deps: edgesOf(root), i: 0}];
    state.set(root, 'visiting');
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.deps.length) {
        const dep = frame.deps[frame.i++];
        if (skip.has(dep) || state.has(dep)) continue;
        state.set(dep, 'visiting');
        work.push({file: dep, deps: edgesOf(dep), i: 0});
        continue;
      }
      work.pop();
      state.set(frame.file, 'done');
      out.push(frame.file);
    }
  }
  return out;
}

/**
 * Link groups for `declarations` mode: for every non-trivial SCC among the
 * eager modules, the post-order range [min index, max index] of its members.
 * Overlapping ranges are merged. Returns [[start, count], ...] sorted.
 */
function linkGroups(order, edgesOf) {
  const position = new Map(order.map((f, i) => [f, i]));
  const inOrder = (f) => position.has(f);
  const components = stronglyConnectedComponents(order, (f) => edgesOf(f).filter(inOrder));
  const ranges = components
    .filter((c) => c.length > 1)
    .map((c) => {
      const idx = c.map((f) => position.get(f));
      return [Math.min(...idx), Math.max(...idx)];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged.map(([a, b]) => [a, b - a + 1]);
}

// ---------------------------------------------------------------- rewriting

/** The exact relative specifier Rollup writes for `to` inside `from`. */
function relativeSpecifier(from, to) {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function replaceSpecifier(code, oldSpec, newSpec) {
  let out = code;
  for (const q of ['"', "'"]) {
    out = out.split(`${q}${oldSpec}${q}`).join(`${q}${newSpec}${q}`);
  }
  return out;
}

const STATEMENT_SPECIFIER_RES = [
  /^\s*(?:import|export)\b[^\n]*?\bfrom\s*(['"])([^'"]+)\1/gm,
  /^\s*import\s*(['"])([^'"]+)\1\s*;?\s*$/gm,
];

// --------------------------------------------------------------------- html

function bootstrapScript(mode) {
  // Created before anything else so every build measures from the same origin.
  return `
      window.__SMP__ = {
        t0: performance.now(),
        mode: ${JSON.stringify(mode)},
        marks: Object.create(null),
        modExec: [],
        registered: [],
        mark(name, value) {
          this.marks[name] = value === undefined ? performance.now() : value;
        },
      };
      window.__modExec = function (id, specifier) {
        window.__SMP__.modExec.push({id: id, s: specifier, t: performance.now()});
      };`;
}

function unsupportedBanner(what, cl) {
  return `
      (function () {
        var root = document.getElementById('root') || document.body;
        root.innerHTML =
          '<div style="font:14px/1.5 -apple-system,sans-serif;max-width:52em;' +
          'margin:12vh auto;padding:24px;border:1px solid #e1e3e5;border-radius:12px">' +
          '<h1 style="font-size:18px;margin:0 0 8px">This build needs the patched Chromium</h1>' +
          '<p>${what}</p>' +
          '<p>Build it from the <code>specifier_inline_modules</code> branch ' +
          '(${cl}) and run it with <code>--enable-blink-features=ModuleDeclarations</code>, ' +
          'or open <a href="../baseline/">the baseline build</a>.</p></div>';
        window.__SMP__.mark('unsupported');
      })();`;
}

function renderHtml({mode, cssFiles, entrySrc, importMap, moduleMap, title}) {
  const css = cssFiles
    .map((f) => `    <link rel="stylesheet" href="./${f}">`)
    .join('\n');

  let body;
  if (mode === 'streamed') {
    body = `    <script type="importmap">
${JSON.stringify({imports: importMap})}
    </script>
    <script>
      window.__STREAM__ = ${JSON.stringify(moduleMap)};
    </script>
    <script src="./streamed-loader.js"></script>`;
  } else if (mode === 'declarations') {
    body = `    <script>
      if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('module-declarations')) {${unsupportedBanner(
        'This page loads its JavaScript as a <code>&lt;script type=&quot;module-declarations&quot;&gt;</code> ' +
          'bundle - one response holding many named modules, compiled on worker threads and executed while ' +
          'the rest is still downloading. That script type is a prototype of TC39 module declarations and ' +
          'is not a shipping web feature.',
        'the ModuleDeclarations runtime flag',
      )}
      }
      window.__SMP__.mark('streamStart');
    </script>
    <script type="module-declarations" src="./${entrySrc}"
      onload="window.__SMP__.mark('bundleLoaded')"
      onerror="window.__SMP__.mark('bundleError')"></script>`;
  } else {
    body = `    <script type="module" src="./${entrySrc}"></script>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} — ${mode}</title>
    <script>${bootstrapScript(mode)}
    </script>
${css}
  </head>
  <body>
    <div id="root"></div>
${body}
    <script>window.__SMP__.mark('htmlParsed');</script>
  </body>
</html>
`;
}

// ------------------------------------------------------------------- plugin

export default function streamedModules(userOptions = {}) {
  const opts = {...DEFAULTS, ...userOptions};
  let loaderSource = '';

  return {
    name: 'streamed-modules',
    enforce: 'post',
    apply: 'build',

    buildStart() {
      if (opts.mode === 'streamed') {
        loaderSource = readFileSync(
          join(__dirname, '..', 'loader', 'streamed-loader.js'),
          'utf8',
        );
      }
    },

    generateBundle(_outputOptions, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      const cssFiles = Object.values(bundle)
        .filter((c) => c.type === 'asset' && c.fileName.endsWith('.css'))
        .map((c) => c.fileName);
      const entryChunk = chunks.find((c) => c.isEntry);

      // ---------------------------------------------------------- baseline
      if (opts.mode === 'baseline') {
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: renderHtml({
            mode: 'baseline',
            cssFiles,
            entrySrc: entryChunk.fileName,
            title: opts.title,
          }),
        });
        this.info(
          `baseline: 1 module, ${(Buffer.byteLength(entryChunk.code) / 1024).toFixed(0)} kB`,
        );
        return;
      }

      // ------------------------------------------------ shared: the graph
      const byFile = new Map(chunks.map((c) => [c.fileName, c]));
      const fileOfModuleId = new Map();
      for (const chunk of chunks) {
        for (const id of chunk.moduleIds ?? []) fileOfModuleId.set(id, chunk.fileName);
        if (chunk.facadeModuleId) fileOfModuleId.set(chunk.facadeModuleId, chunk.fileName);
      }
      const chunkImports = (file) =>
        [...byFile.get(file).imports, ...byFile.get(file).dynamicImports].filter(
          (f) => byFile.has(f),
        );
      // Static imports in *source order*, from Rollup's module graph, so the
      // declarations order is the real ES evaluation order.
      const staticImportsInSourceOrder = (file) => {
        const chunk = byFile.get(file);
        const moduleId = chunk.facadeModuleId ?? chunk.moduleIds?.[0];
        const info = moduleId ? this.getModuleInfo(moduleId) : null;
        if (!info) return chunkImports(file);
        const out = [];
        for (const id of info.importedIds) {
          const f = fileOfModuleId.get(id);
          if (f && byFile.has(f) && f !== file && !out.includes(f)) out.push(f);
        }
        // Anything Rollup lists on the chunk but we could not map (rare).
        for (const f of chunk.imports) {
          if (byFile.has(f) && !out.includes(f)) out.push(f);
        }
        return out;
      };

      let order;
      let cyclic = new Set();
      let dropped = [];

      let groups = [];
      let lazy = new Set();

      if (opts.mode === 'declarations') {
        // Eager part: ES evaluation order of the entry's static graph.
        const result = evaluationOrder(entryChunk.fileName, staticImportsInSourceOrder);
        const eager = result.order;
        groups = result.cycles.length ? linkGroups(eager, staticImportsInSourceOrder) : [];

        // Lazy tail: everything reachable only through dynamic import(), each
        // target's static subtree in post-order, after the eager modules.
        const emitted = new Set(eager);
        const dynamicTargets = [];
        const collectDynamicTargets = (files) => {
          for (const f of files) {
            for (const d of byFile.get(f).dynamicImports) {
              if (byFile.has(d) && !dynamicTargets.includes(d)) dynamicTargets.push(d);
            }
          }
        };
        collectDynamicTargets(eager);
        let tail = [];
        for (let i = 0; i < dynamicTargets.length; i++) {
          const more = appendPostOrder([dynamicTargets[i]], staticImportsInSourceOrder, emitted);
          more.forEach((f) => emitted.add(f));
          tail = tail.concat(more);
          collectDynamicTargets(more); // a lazy module may itself import() more
        }
        // A cycle inside the lazy tail would need its own group; not supported.
        for (const f of tail) {
          for (const d of staticImportsInSourceOrder(f)) {
            if (tail.includes(d) && tail.indexOf(d) > tail.indexOf(f)) {
              this.error(`cyclic import among lazily loaded modules is not supported: ${f} -> ${d}`);
            }
          }
        }
        lazy = new Set(tail);
        order = [...eager, ...tail];
        dropped = chunks.map((c) => c.fileName).filter((f) => !emitted.has(f));
      } else {
        const roots = [entryChunk.fileName, ...chunks.map((c) => c.fileName)];
        const components = stronglyConnectedComponents(roots, chunkImports);
        for (const component of components) {
          if (component.length > 1) component.forEach((f) => cyclic.add(f));
        }
        order = components.flat();
      }

      const specifierOf = new Map(order.map((file, i) => [file, `m${i}`]));

      // 1. Rewrite every relative import to its bare specifier.
      for (const file of order) {
        const chunk = byFile.get(file);
        // Vite's build-import-analysis plugin replaces this marker with the
        // preload list of each dynamic import - in a generateBundle hook that
        // runs after this one, on chunks we have removed by then. With
        // modulePreload off the list is empty anyway.
        let code = chunk.code.split('__VITE_PRELOAD__').join('[]');
        for (const dep of [...chunk.imports, ...chunk.dynamicImports]) {
          if (!specifierOf.has(dep)) continue;
          code = replaceSpecifier(
            code,
            relativeSpecifier(chunk.fileName, dep),
            specifierOf.get(dep),
          );
        }
        chunk.code = code;
      }

      // 2. Validate: every import precedes its importer (unless it is in a
      //    streamed-mode cyclic fallback), and no foreign specifier survives.
      const position = new Map(order.map((file, i) => [file, i]));
      const groupOf = (i) => groups.find(([start, count]) => i >= start && i < start + count);
      for (const file of order) {
        const chunk = byFile.get(file);
        for (const dep of chunk.imports) {
          if (!byFile.has(dep)) continue;
          if (!position.has(dep)) {
            this.error(`${file} imports ${dep}, which was dropped as unreachable`);
          }
          if (cyclic.has(dep)) continue; // streamed-mode fallback file
          const from = position.get(file);
          const to = position.get(dep);
          if (to >= from && !(groupOf(from) && groupOf(from) === groupOf(to))) {
            this.error(
              `ordering violation: ${file} (#${from}) imports ${dep} (#${to}), ` +
                `which arrives later and is not in the same link group`,
            );
          }
        }
        for (const dep of chunk.dynamicImports) {
          if (byFile.has(dep) && !position.has(dep)) {
            this.error(`${file} import()s ${dep}, which was dropped as unreachable`);
          }
          // In declarations mode a forward import() is fine: Blink pre-registers
          // every declared module, so the importer waits for it.
        }
        for (const re of STATEMENT_SPECIFIER_RES) {
          for (const match of chunk.code.matchAll(re)) {
            if (!/^m\d+$/.test(match[2])) {
              this.error(
                `unrewritten specifier ${JSON.stringify(match[2])} in ${file} - ` +
                  `it would be fetched from the network`,
              );
            }
          }
        }
      }

      // 3. Emit.
      const epilogueFor = (i, specifier) =>
        opts.instrument
          ? `\n;globalThis.__modExec&&globalThis.__modExec(${i},${JSON.stringify(specifier)});`
          : '';

      // Remove the per-module chunks; only the bundle ships.
      for (const chunk of chunks) delete bundle[chunk.fileName];

      if (opts.mode === 'declarations') {
        emitDeclarations(this, {order, byFile, specifierOf, epilogueFor, cssFiles, dropped, entryChunk, groups, lazy});
      } else {
        emitStreamed(this, {order, byFile, specifierOf, epilogueFor, cssFiles, cyclic, entryChunk, loaderSource});
      }
    },
  };

  // -------------------------------------------------------- declarations
  function emitDeclarations(ctx, {order, byFile, specifierOf, epilogueFor, cssFiles, dropped, entryChunk, groups, lazy}) {
      const manifestModules = [];
      const records = [];
      let bodyBytes = 0;

      order.forEach((file, i) => {
        const specifier = specifierOf.get(file);
        const body = `${byFile.get(file).code}${epilogueFor(i, specifier)}`;
        const length = Buffer.byteLength(body);
        // Third element is a flags bitfield; bit 1 = lazy (dynamic-import target).
        manifestModules.push(lazy.has(file) ? [specifier, length, 1] : [specifier, length]);
        records.push(`module ${specifier} {\n${body}\n}\n`);
        bodyBytes += length;
      });

      const manifest = {
        v: 1,
        entry: specifierOf.get(entryChunk.fileName),
        modules: manifestModules,
        ...(groups.length ? {groups} : {}),
      };
      const source =
        `//# module-declarations ${JSON.stringify(manifest)}\n` + records.join('');

      ctx.emitFile({type: 'asset', fileName: opts.bundleName, source});
      ctx.emitFile({
        type: 'asset',
        fileName: 'bundle-map.json',
        source: JSON.stringify(
          {
            ...manifest,
            files: order.map((f, i) => [`m${i}`, f]),
            dropped,
          },
          null,
          2,
        ),
      });
      ctx.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: renderHtml({
          mode: 'declarations',
          cssFiles,
          entrySrc: opts.bundleName,
          title: opts.title,
        }),
      });

      ctx.info(
        `declarations: ${order.length} modules, ${(Buffer.byteLength(source) / 1024).toFixed(0)} kB ` +
          `(${((Buffer.byteLength(source) - bodyBytes) / 1024).toFixed(1)} kB of framing), ` +
          `entry ${manifest.entry}` +
          (groups.length ? `, ${groups.length} link group(s) ${JSON.stringify(groups)}` : '') +
          (lazy.size ? `, ${lazy.size} lazy` : '') +
          (dropped.length
            ? `, dropped ${dropped.length} unreachable: ${dropped.map((f) => f.split('/').pop()).join(', ')}`
            : ''),
      );
  }

  // ------------------------------------------------------------ streamed
  function emitStreamed(ctx, {order, byFile, specifierOf, epilogueFor, cssFiles, cyclic, entryChunk, loaderSource}) {
      const urlOf = (file, i) =>
        cyclic.has(file) ? `./${opts.fallbackDir}${i}.js` : `${opts.virtualBase}${i}.js`;

      const parts = [];
      const modules = [];
      let offset = 0;
      let streamedCount = 0;

      order.forEach((file, i) => {
        const specifier = specifierOf.get(file);
        const source = `//! mod ${i} ${specifier} <- ${file}\n${byFile.get(file).code}${epilogueFor(i, specifier)}\n`;
        if (cyclic.has(file)) {
          ctx.emitFile({type: 'asset', fileName: `${opts.fallbackDir}${i}.js`, source});
        } else {
          const bytes = Buffer.byteLength(source);
          parts.push(source);
          modules.push({i, s: specifier, o: offset, l: bytes, f: file});
          offset += bytes;
          streamedCount++;
        }
      });

      ctx.emitFile({type: 'asset', fileName: opts.bundleName, source: parts.join('')});

      const position = new Map(order.map((file, i) => [file, i]));
      const moduleMap = {
        bundle: `./${opts.bundleName}`,
        total: offset,
        entry: specifierOf.get(entryChunk.fileName),
        entryIndex: position.get(entryChunk.fileName),
        modules,
      };
      ctx.emitFile({
        type: 'asset',
        fileName: 'bundle-map.json',
        source: JSON.stringify(moduleMap, null, 2),
      });

      const importMap = {};
      order.forEach((file, i) => {
        importMap[specifierOf.get(file)] = urlOf(file, i);
      });

      ctx.emitFile({type: 'asset', fileName: 'streamed-loader.js', source: loaderSource});
      ctx.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: renderHtml({mode: 'streamed', cssFiles, importMap, moduleMap, title: opts.title}),
      });

      ctx.info(
        `streamed: ${streamedCount} modules, ${(offset / 1024).toFixed(0)} kB` +
          (cyclic.size
            ? `, ${cyclic.size} cyclic modules served as separate files`
            : ', no cycles'),
      );
  }
}
