import React, {useMemo} from 'react';
import {marked} from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import {Card} from '../components/ui.jsx';
import {compute_screen_004, summarize_screen_004} from '../generated/index.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('yaml', yaml);

const SOURCE = `# Streamed module execution

A bundle is normally one big module. The browser must download **all** of it,
parse it, and only then can any of it run.

Both prototypes here emit the same module graph as *separate ES modules in
dependency order* inside one file, so that each module can run as soon as its
bytes have arrived. They differ in who splits the file.

## 1. \`module-declarations\` (native, this build)

A form of [TC39 module declarations](https://github.com/tc39/proposal-module-declarations),
handled by Blink:

\`\`\`js
//# module-declarations {"v":1,"entry":"m2","modules":[["m0",19],["m1",45],["m2",30]]}
module m0 {
export const x = 1;
}
module m1 {
import {x} from 'm0';
export const y = x + 1;
}
module m2 {
import {y} from 'm1';
console.log(y);
}
\`\`\`

\`\`\`html
<script type="module-declarations" src="./bundle.js"></script>
\`\`\`

Blink streams the response and, the moment a module's bytes are complete, hands
them to a **V8 streaming-compile task on a worker thread**. Modules are linked
and evaluated in file order as they become ready, so evaluation overlaps the
download - and parsing stays off the main thread, in parallel.

A bare specifier inside a body that names a sibling declaration resolves to it,
the way a declaration's binding is in lexical scope in the proposal. (The
proposal spells that \`from m0\`; V8 has no syntax for it yet, so the quotes stay.)

## 2. Inline \`specifier\` modules (the 2024 polyfill)

\`\`\`js
function executeModule(specifier, code) {
  const script = document.createElement('script');
  script.type = 'module';
  script.specifier = specifier;   // <- Chromium CL 5649434
  script.textContent = code;
  document.head.append(script);
}
\`\`\`

A page-side loader splits the stream and injects each module as an inline
module script. It works, but an inline module is compiled **on the main thread
at insertion**: it forfeits V8's background streaming compile, which is why it
loses on fast links.

## Why order matters

\`\`\`diff
- one module, executes at the end
+ N modules, each executes as soon as its bytes land
\`\`\`

The bundler emits modules in the entry's dependency post-order - the exact order
ES would evaluate them in - so running them as they arrive is observably the
same as running the entry after the whole file arrived, just earlier.
`;

export default function Docs() {
  const html = useMemo(() => {
    const renderer = new marked.Renderer();
    renderer.code = ({text, lang}) => {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      const out =
        language === 'plaintext'
          ? text.replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]))
          : hljs.highlight(text, {language}).value;
      return `<pre class="hljs"><code>${out}</code></pre>`;
    };
    return marked.parse(SOURCE, {renderer});
  }, []);

  return (
    <>
      <Card title="How it works" wide>
        {/* eslint-disable-next-line react/no-danger */}
        <div className="markdown" dangerouslySetInnerHTML={{__html: html}} />
      </Card>
      <Card title="screen_004">
        <p className="muted">
          checksum <code>{compute_screen_004()}</code>, rows{' '}
          {summarize_screen_004().rows}
        </p>
      </Card>
    </>
  );
}
