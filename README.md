# Streamed ES module bundle execution

Prototypes of one bundle whose modules **execute while the bundle is still
downloading**, instead of waiting for the whole file to arrive and parse.

Three builds of the same app:

| mode | what ships | who splits it | parse |
| --- | --- | --- | --- |
| `baseline` | one flattened module | nobody | one background streaming compile |
| `streamed` | concatenated modules + byte map | a page-side loader, via `<script type=module specifier>` ([CL 5649434][cl]) | **main thread**, at insertion |
| `declarations` | a form of [TC39 module declarations][tc39] | Blink, via `<script type="module-declarations">` (new in this branch) | **worker threads**, in parallel, as bytes arrive |

`declarations` is the one that keeps both properties we want - evaluation
overlapping the download *and* parsing off the main thread. `streamed` redoes a
2024 polyfill of the same idea and is kept for comparison. Both need the
Chromium side, which is [CL 5649434][cl] (WIP prototype: the
`module-declarations` script type plus the `specifier` attribute).

[cl]: https://chromium-review.googlesource.com/c/chromium/src/+/5649434
[tc39]: https://github.com/tc39/proposal-module-declarations

```
                bundle.js (one response, streamed)
  ┌──────────┬──────────┬──────────┬────  ...  ────┬──────────┐
  │ module m0│ module m1│ module m2│               │module m641│
  │  leaf    │  leaf    │          │               │  entry   │
  └──────────┴──────────┴──────────┴────  ...  ────┴──────────┘
       ↓          ↓          ↓                          ↓
    compile    compile    compile   (worker threads)  compile
       ↓          ↓          ↓                          ↓
     eval       eval       eval     (main, in order)   eval → app boots
```

## Quick start

```bash
npm install
npm run gen                 # 176 synthetic feature modules (SPIN_SCALE=5 for eval-heavy, CYCLE=0 to drop the cycle)
npm run build               # dist/{baseline,streamed,declarations}  (MINIFY=1 INSTRUMENT=0 for production shape)
npm run serve               # /baseline/  /  (streamed)  /declarations/
npm run measure -- --kbps 4000 --runs 3 --chrome /path/to/patched/Chromium
```

`/` and `/declarations/` need the patched Chromium ([CL 5649434][cl], run with
`--enable-blink-features=ModuleDeclarations`). Without it the pages say so and
point at `/baseline/`. `npm test` runs the loader's correctness cases
(`tests/cases.mjs`) against it; pass `--chrome <path>` or set `CHROME`. The CDP
tools (`inspect`, `listen`, `probe`, `title-probe`) read `CHROME`.

## What is in here

| Path | What it is |
| --- | --- |
| `plugin/streamed-modules.js` | The Vite/Rollup plugin. Keeps the module graph separable and emits it in one of the three shapes, plus the HTML for each. |
| `loader/streamed-loader.js` | `streamed` mode only. Page-side loader: streams the bundle and injects each module as an inline module script. `declarations` mode has no page-side loader - Blink does it. |
| `src/` | The app: React + react-router + echarts + marked + highlight.js + zod + lodash-es + date-fns, seven views. |
| `src/generated/` | 176 generated feature modules (`npm run gen`), layered prim → svc → feat → screen, each with a data table and module-level init cost. |
| `tools/serve.mjs` | Static server with accurate bandwidth/latency shaping. |
| `tools/measure.mjs` | Runs both builds N times, prints a comparison. |
| `tools/inspect.mjs` | CDP driver: console, marks, optional screenshot. |
| `tools/listen.mjs` | Listen-only CDP client. What you want when a page produces nothing. |
| `tools/probe.mjs`, `tools/title-probe.mjs` | Poll one expression / `document.title` (the latter via the DevTools HTTP endpoint, so it survives a wedged page). |
| `tools/gen-chain-test.mjs` | Standalone pages that inject N chained inline modules, to measure injection cost on its own. |
| `tools/site-js-profile.mjs` | Live site: startup JS files and bytes, per-file vs one-stream brotli. |
| `tools/site-critical-js.mjs`, `tools/site-critical-js-report.mjs`, `tools/site-critical-js-model.mjs` | Live-site startup profiling: record over CDP (network with initiators, bodies, a 100 µs CPU trace; optional CPU throttling and socket-layer network delay), analyse it (evaluation gates, per-file bytes and evaluation, link usage), and model one module-declarations bundle on slow links. |
| `tools/socket-throttle-check.mjs` | Local sanity check for socket-layer (or legacy CDP) network throttling. |
| `tests/cases.mjs`, `tests/run.mjs` | Hand-built `module-declarations` bundles covering order, errors, UTF-8, a cycle (link group), lazy modules and forward `import()`, and a forward reference without a group. `npm test`. |

## How the bundle is made separable

A normal ES bundle is **one module**: Rollup flattens every input module into a
single scope and renames bindings, so there are no boundaries left to stream.
That is the exact wall the 2024 prototype hit —

> the bundler strips all the module dependencies!! What do we import??

The fix is to not let it flatten. `output.preserveModules: true` makes Rollup
emit one chunk per input module with real `import`/`export` statements between
them, and the plugin then rewrites relative specifiers to bare ones
(`./foo.js` → `m17`) and concatenates. It **fails the build** if any module
would arrive before something it imports, or if a non-`m<N>` specifier survives
(it would be fetched from the network).

### `declarations` mode

The output is proposal-shaped:

```js
//# module-declarations {"v":1,"entry":"m641","modules":[["m0",231],["m1",121],…]}
module m0 {
…body…
}
module m1 {
import {x} from 'm0';
…
}
```

* **Manifest first**: names and UTF-8 byte length of each body, in order. Blink
  reads it from the first line and from then on knows exactly where every
  module ends, with no tokenizing.
* **ES evaluation order.** Modules are emitted in the entry's DFS post-order
  over static imports (from Rollup's module graph, in source order) - the exact
  order ES would evaluate the graph in. So Blink evaluating them in file order
  as they arrive is observably identical to evaluating the entry after the whole
  file arrived, just earlier. Unreachable modules are dropped; cyclic imports
  are a build error (a module in a cycle would arrive before something it
  imports).
* **String specifiers.** The proposal spells `import {x} from m0` with an
  identifier. V8 has no syntax for that, so bodies keep the quotes and Blink
  gives bare specifiers bundle-scoped resolution instead (below). A bundler
  targeting real module declarations would drop the quotes; nothing else
  changes.
* **19 kB of framing** for 642 modules: the manifest plus `module m {`/`}`
  wrappers. Import/export statements (~93 kB) are the inherent cost of keeping
  modules separate in any of these schemes.

### `streamed` mode

Tarjan SCC order, a byte map, an import map (`m17` → `./v/17.js`, never
fetched) inlined in the HTML, and `loader/streamed-loader.js` doing the split
on the page. Cyclic SCCs fall back to real files.

## The Blink side (`declarations` mode)

All in `third_party/blink/renderer/core/script/module_declarations_loader.{h,cc}`
plus small hooks, behind the `ModuleDeclarations` runtime flag:

* `<script type="module-declarations" src>` (`ScriptLoader::PrepareScript`) fetches
  the bundle as a script (same CSP directive, destination, CORS and credentials
  as a module script) through `RawResource` with buffering disabled, so the body
  arrives incrementally in `DataReceived()`.
* Once the manifest line is in, every declared name is registered with the
  `Modulator`. **Bundle-scoped resolution**: a bare specifier imported from a
  module whose base URL is `bundle.js#anything`, and which names a sibling
  declaration, resolves to `bundle.js#name` before import maps are consulted
  (`ModulatorImplBase::ResolveModuleSpecifier`). This is the lexical-scope part
  of the proposal; no import map is needed and `import.meta.url` is
  `bundle.js#m17`.
* When a module's bytes are complete they go to a **V8 streaming-compile task
  on a worker thread** (`ScriptCompiler::StartStreaming(kModule)`, the same
  machinery as `BackgroundInlineScriptStreamer`). Several modules compile in
  parallel while later ones are still downloading. On completion the main
  thread finalizes (`JSModuleScript::Create` with a streamer) and adds the
  module to the module map via upstream's `AddEntryToModuleMap`.
* Modules are **linked and evaluated in file order** as soon as each and all
  before it are ready. A dependency is always earlier in the file, so linking
  module *i* links only *i*. Evaluation stops at the first error, as it would
  for one module graph, and the element gets `error`; otherwise `load` fires
  after the entry ran and every module - lazy ones too - is registered. The
  load event is delayed until then.
* **Link groups** (`"groups":[[start,count],…]`): a cycle's members are the
  post-order range from its first member to its DFS root. Blink waits until
  the whole range has compiled, then instantiates and evaluates the *root*;
  V8 links the connected subgraph and produces the ES evaluation order.
* **Lazy modules** (`["m644",435,1]`): targets of dynamic `import()`, emitted
  after the eager modules. Compiled and registered, not evaluated until
  imported.
* **Pending module-map entries.** Every declared module gets a "fetching"
  entry as soon as the manifest is in (`ModuleMap::AddPendingEntry`), resolved
  when it compiles. A forward `import()`, or an inline module on the page,
  that gets there first waits for the bundle instead of fetching
  `bundle.js#m5`. On failure the pending entries are rejected so waiters fail
  instead of hanging.
* `HTMLScriptElement.supports('module-declarations')` is the feature test.

Console output on success, e.g.
`evaluated 642 modules … (642 compiled on worker threads, 0 on the main thread;
main thread spent 61 ms finalizing compiles and 1257 ms linking+evaluating)`.

### Not done (prototype limits)

* Inline `<script type="module-declarations">` (needs the syntax in V8).
* SRI / `integrity`, per-module code caching, preload-scanner integration.
* A cycle among *lazy* modules (would need groups in the lazy tail; the
  bundler rejects it).

## Findings

All numbers below are from a **release** build (`is_debug=false`, DCHECKs
off, `symbol_level=0`), median of 3 runs,
`tools/measure.mjs`. "work after last byte" = paint − Resource Timing
`responseEnd` of the bundle: what could *not* be overlapped with the download.
The app has 645 modules incl. one import cycle (`svc_000` ↔ `svc_001`, a link
group) and one forward `import()` (`lib/report.js`, a lazy module).

### 1. Streaming execution hides evaluation inside the download

Eval-heavy app (`SPIN_SCALE=5`, ~4.3 s of evaluation):

| painted | declarations | streamed (inline) | baseline |
| --- | --- | --- | --- |
| unthrottled | 5.77 s | 5.83 s | 5.74 s |
| 20 000 kbps | **6.52 s** (2.97 s after last byte) | 6.57 s | 7.76 s (4.34 s after) |
| 4 000 kbps | **12.04 s** (26 ms after last byte) | 12.00 s | 15.88 s (4.32 s after) |

At 4 000 kbps every millisecond of the 4.3 s of evaluation runs while bytes are
still arriving: **3.85 s earlier to paint**. At 20 000 kbps the 2.1 s download
absorbs about a third of it.

Byte-heavy app (`SPIN_SCALE=1`, ~0.95 s of evaluation - closer to a typical
bundle), production-shaped (minified, no instrumentation):

| painted | declarations | streamed | baseline |
| --- | --- | --- | --- |
| 20 000 kbps | **2.94 s** (33 ms after last byte) | 2.96 s | 3.80 s (976 ms after) |
| 4 000 kbps | **8.91 s** (37 ms after last byte) | 8.91 s | 9.61 s (978 ms after) |

### 2. The cost of keeping modules separate is bytes, not CPU

Unthrottled, all three builds paint within ~90 ms of each other, in both apps.
So in a release build:

* **Per-module overhead of the native loader is not measurable** (645
  `JSModuleScript`s, module-map entries, link + evaluate calls: noise).
* **The inline polyfill's main-thread compile costs 44 ms for 5.2 MB**,
  measured directly (`marks.mainThreadCompileMs`, the summed `appendChild`
  time of all 645 inline modules), against 6 ms of main-thread finalize in the
  native loader - a 38 ms difference on ~950 ms of main-thread work. Not the
  3.4 s the debug build showed: its DCHECK-heavy parser inflated compile ~75×.
  The concern that motivated the native design is real but, on this desktop
  CPU, 4 % of the work. It scales with device speed, bundle size and how much
  top-level code is eager (function bodies are lazily pre-parsed), and the
  native path also keeps that work off the thread that handles input during
  load. Repeat visits are not measured at all yet: the baseline gets V8's code
  cache, inline modules never can, and a native bundle could cache per module.
* **What does cost is size.** Separated modules are **+3.4 % minified**
  (+122 kB here): ~19 kB manifest + `module m {}` framing, and ~100 kB of
  import/export statements plus exported identifiers that a minifier can no
  longer mangle across module boundaries (`compute_svc_000` has to stay
  `compute_svc_000`). At 4 000 kbps that is ~0.25 s, a quarter of the
  byte-heavy win. A minifier that knows the bundle is closed could mangle
  exports consistently and recover most of it.

### 3. Correctness under the new semantics

`svc_000` ↔ `svc_001` is linked and evaluated as one group in ES order;
`import('./lib/report.js')` from `main` resolves to a module declared *after*
`main` through its pending module-map entry (the measurement report itself is
posted through it). The standalone cases in `tests/` (cycle order `B,C,A,E`,
lazy chains, never-imported lazy modules, forward references without a group,
evaluation errors, UTF-8 byte accounting) pass on both the debug and release
binaries. The forward-reference case is decided from the manifest order, not
from which module happens to compile first - an earlier version of the loader
let that race decide, and the test caught it.

### 4. What bounds the win

* **Evaluation that arrives late cannot be hidden.** The first version of
  `src/lib/data.js` did 756k `date-fns` `format()` calls; that one module was
  84 % of all evaluation and sat 92 % of the way into the bundle (it imports
  the screens barrel, so it depends on everything). Streaming execution helps
  in proportion to how much cost lives in modules the bundler can place early.
* **Bytes**, as above.

### Debug-build numbers (superseded)

The earlier round of measurements used the debug build. They were directionally
right about streaming execution but wrong about magnitudes: they put the inline
polyfill 3.3 s behind the baseline unthrottled and the native loader 0.3 s
behind. In release both gaps are within noise. Do not quote them.

## The Chromium patches

Uploaded as [CL 5649434][cl] (WIP). On top of upstream `main` as of
2026-09-25.

### `module-declarations` (new)

```
third_party/blink/renderer/core/script/module_declarations_loader.{h,cc}   new, ~800 lines
third_party/blink/renderer/core/script/script_loader.{h,cc}                new script type + dispatch
third_party/blink/renderer/core/script/modulator{,_impl_base}.{h,cc}       RegisterModuleDeclarationsBundle, pending entries, resolver hook
third_party/blink/renderer/core/script/module_map.{h,cc}                   Add/Resolve/RejectPendingEntry
third_party/blink/renderer/core/html/html_script_element.cc                 supports('module-declarations')
third_party/blink/renderer/core/html/parser/html_preload_scanner.cc         new enum case
third_party/blink/renderer/core/testing/dummy_modulator.{h,cc}
third_party/blink/renderer/core/script/script_type_names.json5             "module-declarations"
third_party/blink/renderer/platform/runtime_enabled_features.json5         ModuleDeclarations (experimental)
third_party/blink/renderer/platform/heap/self_keep_alive_creation_key.h    allow-list
```

Run with `--enable-blink-features=ModuleDeclarations`.

Measure on a release build (`is_debug=false`, `dcheck_always_on=false`,
`is_component_build=true`, `symbol_level=0`): a debug build's DCHECKs inflate
parsing ~75×. `tools/measure.mjs --chrome <path>` picks the binary; all numbers
in this file are from a release build.

### `specifier` attribute (CL 5649434, rebased)

Two things changed during the rebase beyond mechanical conflicts:

1. **It now reuses upstream's `Modulator::AddEntryToModuleMap()`.** When the CL
   was written that did not exist, so it hand-rolled
   `ModuleMap::AddInlineModuleScript` plus `Entry::SetModuleScript` /
   `SetNotFetching`. Upstream has since added all of it (for inline CSS
   modules), so the patch is now ~20 lines smaller than it was.

2. **`ScriptSchedulingType::kImmediate` is no longer forced**, and
   `FetchRootInline` is back to posting a task. The original CL forced immediate
   scheduling so a `specifier` module would evaluate synchronously on insertion.
   That crashes the renderer as soon as the module has imports:

   ```
   FATAL module_pending_script.cc:70] Check failed: IsReady().
     blink::ModulePendingScript::GetSource()
     blink::ContainerNode::DidInsertNodeVector(...)
   ```

   `kImmediate` reads the source during insertion, but a module with imports is
   not ready until its descendant fetch reports back — and that is a posted task
   even when every dependency is already in the module map, because
   `ModuleMap::Entry::AddClient` always dispatches asynchronously. The CL's own
   comments show this was the open problem ("kImmediate needs IsReady()...
   that's why they aren't executing when expected").

   Normal scheduling is sufficient: the module map entry is added synchronously
   during `PrepareScript`, so a module is importable the instant it is inserted,
   and V8 evaluates a module's dependencies before the module itself. Execution
   order across injected scripts therefore does not need to be guaranteed.

   Making it synchronous again would mean teaching `Entry::AddClient` to notify
   synchronously when `is_fetching_` is already false — worth trying, since it
   would tighten the overlap, but it is a re-entrancy risk in a shared code path.

## Ideas not pursued

* **Coalescing tiny modules.** 642 modules is fine-grained; the median is 2.8 kB
  and the smallest is 146 bytes. Merging adjacent leaves would cut per-module
  overhead, but a group's internal imports would have to be rewritten (that is
  scope hoisting, i.e. re-implementing the thing this plugin avoids).
* **Bundle-aware export mangling.** The bundle is closed - every importer of
  every export is in the file - so a minifier could rename exports
  consistently and recover most of the +3.4 % size cost. That is where the
  remaining cost of module separation is.
* **Real syntax.** With `module m0 { … }` in V8, the manifest and framing
  disappear and `from m0` replaces `from 'm0'`; the Blink loader becomes a thin
  streaming driver over V8's parser. Everything measured here should carry over.
* **Code caching.** Inline modules get none.
  A service worker could in principle hand the engine cacheable sources.
* **Yielding between modules.** `whatwg/html#4400`; would let rendering happen
  during a long evaluation run.
* **Preload discovery.** The 2024 notes wanted `<link rel=preload as=fetch>` plus
  a loader that scans preloads. This loader just fetches, since the byte map is
  inlined in the HTML anyway.
