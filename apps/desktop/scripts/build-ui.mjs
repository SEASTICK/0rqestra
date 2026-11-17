// Offline builder for the Stage 2 interface (src/ui -> dist/renderer).
//
// Adapted from the WorkTreeAI preview template's builder. It uses only the repository's own
// TypeScript compiler and the vendored React runtime in vendor/react: no network, no CDN, no eval.
// The template's provider modules (sign-in, key vault, live workflows) are intentionally absent.
// PROVENANCE.md in vendor/react says the real app should later move to pinned npm React and a
// proper bundler; that is a separate step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'ui');
const vendor = path.join(root, 'vendor', 'react');
const outdir = path.join(root, 'dist', 'renderer');

const jsx = { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true };
const plain = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 };

function compile(file, compilerOptions) {
  // .mjs names make TypeScript keep ES module syntax; compile them under a .js name (as the
  // template did) so they become CommonJS for the bundle.
  const fileName = file.replace(/.mjs$/, '.js');
  const out = ts.transpileModule(fs.readFileSync(path.join(src, file), 'utf8'), { fileName, reportDiagnostics: true, compilerOptions });
  const errors = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => root, getCanonicalFileName: (x) => x, getNewLine: () => '\n' }));
  }
  return out.outputText;
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
for (const file of ['index.html', 'app.css', 'recovery.css', 'connections.css', 'tasks.css', 'live.css']) {
  fs.copyFileSync(path.join(src, file), path.join(outdir, file));
}

const modules = {};
for (const name of ['react', 'react-dom', 'react-dom-client', 'scheduler']) {
  modules[name] = fs.readFileSync(path.join(vendor, `${name}.js`), 'utf8');
}
modules.app = compile('App.jsx', jsx);
modules.taskUI = compile('TaskPanels.jsx', jsx);
modules.simulatedProviders = compile('SimulatedProviders.jsx', jsx);
modules.allowance = compile('allowance.mjs', plain);
modules.demo = compile('demo-run.mjs', plain);
modules.camera = compile('camera.mjs', plain);
modules.workflow = compile('task-workflow.mjs', plain);

const aliases = {
  './SimulatedProviders.jsx': 'simulatedProviders', './TaskPanels.jsx': 'taskUI', './task-workflow.mjs': 'workflow',
  './camera.mjs': 'camera', './demo-run.mjs': 'demo', './allowance.mjs': 'allowance', 'react-dom/client': 'react-dom-client',
  'next/dist/compiled/react': 'react', 'next/dist/compiled/react-dom': 'react-dom', 'next/dist/compiled/scheduler': 'scheduler',
};
const body = Object.entries(modules)
  .map(([key, code]) => `${JSON.stringify(key)}:function(module,exports,require){\n${code}\n}`)
  .join(',\n');
const bundle = `/* 0rqestra interface. Third-party notices: THIRD-PARTY-LICENSE.txt */\n(()=>{'use strict';const modules={${body}};const cache={};const aliases=${JSON.stringify(aliases)};function require(name){if(name==='./app.css')return {};name=aliases[name]||name;if(cache[name])return cache[name].exports;if(!modules[name])throw Error('Unknown module '+name);const m=cache[name]={exports:{}};modules[name](m,m.exports,require);return m.exports;}require('app');})();\n`;
fs.writeFileSync(path.join(outdir, 'app.js'), bundle);
fs.copyFileSync(path.join(vendor, 'THIRD-PARTY-LICENSE.txt'), path.join(outdir, 'THIRD-PARTY-LICENSE.txt'));
console.log('Built the 0rqestra interface offline (no provider code; simulated activity only).');
