// Generates standalone pages that inject N chained inline modules, to
// characterise how `<script type="module" specifier>` injection scales
// independently of the app.
//
//   node tools/gen-chain-test.mjs /tmp/chain 20 100 300 642

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const outDir = process.argv[2] || '/tmp/chain';
const sizes = process.argv.slice(3).map(Number);
mkdirSync(outDir, {recursive: true});

for (const n of sizes.length ? sizes : [20, 100, 300, 642]) {
  const imports = {};
  const code = [];
  for (let i = 0; i < n; i++) {
    imports[`c${i}`] = `./cv/${i}.js`;
    code.push(
      i === 0
        ? 'export const v0 = 0;\n'
        : `import {v${i - 1}} from 'c${i - 1}';\nexport const v${i} = v${i - 1} + 1;\n`,
    );
  }
  const lastIdx = n - 1;
  const probe = [
    `import {v${lastIdx}} from 'c${lastIdx}';`,
    // Reported through document.title so it can be read from the DevTools
    // HTTP endpoint without Runtime.evaluate.
    `document.title = 'DONE n=${n} last=' + v${lastIdx} +`,
    `  ' inject=' + window.__inject.toFixed(1) +`,
    `  ' firstEval=' + (window.__firstEval || -1).toFixed(1) +`,
    `  ' total=' + performance.now().toFixed(1);`,
    `document.getElementById('out').textContent = document.title;`,
  ].join('\n');

  writeFileSync(
    join(outDir, `n${n}.html`),
    `<!DOCTYPE html>
<html><head>
<script type="importmap">${JSON.stringify({imports})}</script>
</head><body>
<div id="out">pending</div>
<script>
window.__mark = function () {
  if (window.__firstEval === undefined) window.__firstEval = performance.now();
};
const CODE = ${JSON.stringify(code)};
const t0 = performance.now();
for (let i = 0; i < CODE.length; i++) {
  const s = document.createElement('script');
  s.type = 'module';
  s.specifier = 'c' + i;
  s.textContent = CODE[i] + ';window.__mark();';
  document.head.appendChild(s);
}
window.__inject = performance.now() - t0;
document.title = 'INJECTED ' + CODE.length + ' in ' + window.__inject.toFixed(1) +
  ' firstEval=' + (window.__firstEval === undefined ? -1 : window.__firstEval.toFixed(1));
document.getElementById('out').textContent = document.title;
const probe = document.createElement('script');
probe.type = 'module';
probe.textContent = ${JSON.stringify(probe)};
document.head.appendChild(probe);
</script>
</body></html>
`,
  );
}

console.log(`wrote ${sizes.join(', ')} into ${outDir}`);
