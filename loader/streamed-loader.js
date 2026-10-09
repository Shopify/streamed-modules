/**
 * Streamed ES module execution loader.
 *
 * Reads `window.__STREAM__` (inlined in the HTML by the build, so there is no
 * extra round trip), streams the bundle, and hands each module to the engine
 * the moment its byte range is complete.
 *
 * Each module is injected as an inline module script carrying a `specifier`
 * attribute, which registers it in the module map under the URL that specifier
 * resolves to via the page's import map. That is what lets the *next* module in
 * the stream `import` it by name:
 *
 *     <script type="module" specifier="m17">
 *       import {x} from 'm4';   // already in the module map
 *       export const y = x + 1;
 *     </script>
 *
 * The `specifier` attribute is not a shipping web feature. It comes from
 * https://chromium-review.googlesource.com/c/chromium/src/+/5649434
 */
(function () {
  'use strict';

  var map = window.__STREAM__;
  var T = window.__SMP__;
  var opts = window.__STREAM_OPTS__ || {};
  var keepScripts = opts.keepScripts !== false;

  if (!map || !T) {
    console.error('[streamed-loader] missing __STREAM__ / __SMP__');
    return;
  }

  // ------------------------------------------------------- feature detection
  if (!('specifier' in HTMLScriptElement.prototype)) {
    T.mark('unsupported');
    document.addEventListener('DOMContentLoaded', function () {
      var root = document.getElementById('root') || document.body;
      root.innerHTML =
        '<div style="font:14px/1.5 -apple-system,sans-serif;max-width:52em;' +
        'margin:12vh auto;padding:24px;border:1px solid #e1e3e5;border-radius:12px">' +
        '<h1 style="font-size:18px;margin:0 0 8px">This build needs the patched Chromium</h1>' +
        '<p>Streaming module execution relies on the <code>specifier</code> attribute on ' +
        '<code>&lt;script type="module"&gt;</code>, which is not a shipping web feature.</p>' +
        '<p>Build it from <a href="https://chromium-review.googlesource.com/c/chromium/src/+/5649434">' +
        'CL 5649434</a>, or open <a href="/baseline/">the baseline build</a> to see the app ' +
        'load the conventional way.</p></div>';
    });
    console.error(
      '[streamed-loader] HTMLScriptElement has no "specifier" attribute; ' +
        'run this in a Chromium built with CL 5649434.',
    );
    return;
  }

  // --------------------------------------------------------------- execution
  var modules = map.modules;
  var buffer = new Uint8Array(map.total);
  var decoder = new TextDecoder();
  var received = 0;
  var next = 0;
  var failed = 0;

  function execute(mod, code) {
    var script = document.createElement('script');
    script.type = 'module';
    // Must be set before insertion: preparation happens on insert.
    script.specifier = mod.s;
    script.textContent = code;
    try {
      // appendChild is where an inline module script is compiled - on this
      // thread. Summed over all modules this is the main-thread parse cost
      // that the native module-declarations loader moves to worker threads.
      var t0 = performance.now();
      document.head.appendChild(script);
      T.marks.mainThreadCompileMs = (T.marks.mainThreadCompileMs || 0) + (performance.now() - t0);
      if (!keepScripts) script.remove();
    } catch (err) {
      failed++;
      console.error('[streamed-loader] module ' + mod.s + ' threw', err);
    }
  }

  function drain() {
    while (next < modules.length) {
      var mod = modules[next];
      if (received < mod.o + mod.l) break;
      if (next === 0) T.mark('firstModule');
      execute(mod, decoder.decode(buffer.subarray(mod.o, mod.o + mod.l)));
      next++;
      if (next === modules.length) {
        T.mark('lastModule');
        T.mark('modulesExecuted', next);
      }
    }
  }

  T.mark('streamStart');

  fetch(map.bundle, {credentials: 'same-origin'})
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (!response.body) throw new Error('no streaming body');
      var reader = response.body.getReader();

      function pump() {
        return reader.read().then(function (result) {
          if (result.value && result.value.length) {
            if (received === 0) T.mark('firstByte');
            if (received + result.value.length > buffer.length) {
              throw new Error(
                'bundle is larger than the map says (' +
                  (received + result.value.length) +
                  ' > ' +
                  buffer.length +
                  '); rebuild',
              );
            }
            buffer.set(result.value, received);
            received += result.value.length;
            // Everything whose bytes have landed runs now, not at the end.
            drain();
          }
          if (result.done) {
            T.mark('downloadDone');
            drain();
            if (next < modules.length) {
              console.error(
                '[streamed-loader] stream ended with ' +
                  (modules.length - next) +
                  ' modules still pending',
              );
            }
            if (failed) T.mark('failedModules', failed);
            return undefined;
          }
          return pump();
        });
      }

      return pump();
    })
    .catch(function (err) {
      T.mark('error');
      console.error('[streamed-loader] failed', err);
    });
})();
