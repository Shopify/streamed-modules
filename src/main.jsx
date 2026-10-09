import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import {telemetry} from './lib/runtime.js';
import './styles.css';

telemetry.mark('entryEvaluated');

const root = createRoot(document.getElementById('root'));
root.render(<App />);
telemetry.mark('mounted');

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    telemetry.mark('rendered');
    // Stable shape for tools/measure.mjs to read.
    // The streamed build marks its own download (the loader owns the fetch),
    // but the baseline's is a plain module script - so read both from Resource
    // Timing to compare like for like.
    const scriptEntry = performance
      .getEntriesByType('resource')
      .filter((e) => /bundle\.js|app\.js/.test(e.name))
      .sort((a, b) => b.transferSize - a.transferSize)[0];

    globalThis.__RESULTS__ = {
      mode: telemetry.mode || 'unknown',
      marks: {...telemetry.marks},
      download: scriptEntry
        ? {
            name: scriptEntry.name.split('/').pop(),
            start: +scriptEntry.startTime.toFixed(1),
            responseStart: +scriptEntry.responseStart.toFixed(1),
            responseEnd: +scriptEntry.responseEnd.toFixed(1),
            transferSize: scriptEntry.transferSize,
            // Wall clock spent receiving the body.
            bodyMs: +(scriptEntry.responseEnd - scriptEntry.responseStart).toFixed(1),
          }
        : null,
      modules: telemetry.modExec.length,
      featureModules: telemetry.registered.length,
      firstModuleExec: telemetry.modExec.length ? telemetry.modExec[0].t : null,
      lastModuleExec: telemetry.modExec.length
        ? telemetry.modExec[telemetry.modExec.length - 1].t
        : null,
      nav: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null,
    };
    document.documentElement.setAttribute('data-app-ready', '1');

    // `?report` makes the page post its numbers back, which is how
    // tools/measure.mjs collects runs without a CDP client. The poster lives
    // in a dynamically imported module so every build exercises a forward
    // import(): in the declarations bundle it is a lazy module declared after
    // main, in the baseline it is a separate chunk.
    if (location.search.includes('report')) {
      telemetry.mark('reportImportStart');
      import('./lib/report.js').then(({postResults}) => {
        telemetry.mark('reportImportDone');
        globalThis.__RESULTS__.marks.reportImportStart = telemetry.marks.reportImportStart;
        globalThis.__RESULTS__.marks.reportImportDone = telemetry.marks.reportImportDone;
        postResults(globalThis.__RESULTS__);
      });
    }
  });
});
