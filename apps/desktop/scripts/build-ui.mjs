// Offline builder for the Stage 2 interface (src/ui -> dist/renderer).
//
// Adapted from the 0rqestra preview template's builder. It uses only the repository's own
// TypeScript compiler and the vendored React runtime in vendor/react: no network, no CDN, no eval.
// The template's provider modules (sign-in, key vault, live workflows) are intentionally absent.
// PROVENANCE.md in vendor/react says the real app should later move to pinned npm React and a
// proper bundler; that is a separate step.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
for (const file of ['index.html', 'app.css', 'recovery.css', 'connections.css', 'tasks.css', 'live.css', 'theme.css', 'boot.css', 'boot.js', 'shell.css', 'livechat.css']) {
  fs.copyFileSync(path.join(src, file), path.join(outdir, file));
}

const modules = {};
for (const name of ['react', 'react-dom', 'react-dom-client', 'scheduler']) {
  modules[name] = fs.readFileSync(path.join(vendor, `${name}.js`), 'utf8');
}
modules.app = compile('App.jsx', jsx);
modules.updateUI = compile('UpdateDialog.jsx', jsx);
modules.shell = compile('Shell.jsx', jsx);
modules.theme = compile('theme.mjs', plain);
modules.launch = compile('launch.mjs', plain);
modules.liveChatUI = compile('LiveChat.jsx', jsx);
modules.liveChat = compile('live-chat.mjs', plain);
modules.agentRuntime = compile('AgentRuntime.jsx', jsx);
modules.teamRun = compile('TeamRun.jsx', jsx);
modules.previewUI = compile('Preview.jsx', jsx);
modules.treeLayout = compile('tree-layout.mjs', plain);
modules.activityUI = compile('Activity.jsx', jsx);
modules.agentPanelUI = compile('AgentPanel.jsx', jsx);
modules.markdownUI = compile('Markdown.jsx', jsx);
modules.attachmentsUI = compile('Attachments.jsx', jsx);
modules.memoryUI = compile('Memory.jsx', jsx);
modules.markdown = compile('markdown.mjs', plain);
modules.camera = compile('camera.mjs', plain);
modules.treeRules = compile('tree-rules.mjs', plain);
modules.updateGate = compile('update-gate.mjs', plain);
modules.storageKeys = compile('storage-keys.mjs', plain);
modules.accountsUI = compile('AccountsSetup.jsx', jsx);
modules.accountSetup = compile('account-setup.mjs', plain);
modules.teamsUI = compile('TeamsPage.jsx', jsx);
modules.friendsUI = compile('FriendsPage.jsx', jsx);
modules.teamsText = compile('teams-ui.mjs', plain);
modules.teamBridge = compile('TeamBridge.jsx', jsx);
modules.teamCatchUp = compile('team-catchup.mjs', plain);
modules.migrateDemo = compile('migrate-demo.mjs', plain);
modules.accountWelcome = compile('AccountWelcome.jsx', jsx);
modules.accountUI = compile('account-ui.mjs', plain);

const aliases = {
  './UpdateDialog.jsx': 'updateUI', './camera.mjs': 'camera', './tree-rules.mjs': 'treeRules', './update-gate.mjs': 'updateGate', './storage-keys.mjs': 'storageKeys', './Shell.jsx': 'shell', './theme.mjs': 'theme', './launch.mjs': 'launch', './LiveChat.jsx': 'liveChatUI', './live-chat.mjs': 'liveChat', './AgentRuntime.jsx': 'agentRuntime', './TeamRun.jsx': 'teamRun', './Preview.jsx': 'previewUI', './tree-layout.mjs': 'treeLayout', './Activity.jsx': 'activityUI', './AgentPanel.jsx': 'agentPanelUI', './Markdown.jsx': 'markdownUI', './Attachments.jsx': 'attachmentsUI', './Memory.jsx': 'memoryUI', './markdown.mjs': 'markdown', './AccountsSetup.jsx': 'accountsUI', './account-setup.mjs': 'accountSetup', './TeamsPage.jsx': 'teamsUI', './FriendsPage.jsx': 'friendsUI', './teams-ui.mjs': 'teamsText', './TeamBridge.jsx': 'teamBridge', './team-catchup.mjs': 'teamCatchUp', './migrate-demo.mjs': 'migrateDemo', './AccountWelcome.jsx': 'accountWelcome', './account-ui.mjs': 'accountUI', 'react-dom/client': 'react-dom-client',
  'next/dist/compiled/react': 'react', 'next/dist/compiled/react-dom': 'react-dom', 'next/dist/compiled/scheduler': 'scheduler',
};
// Every local import must resolve inside the bundle. A missing entry above compiles fine but throws
// "Unknown module" when the window starts, which shows as a blank window. Fail the build instead.
const unresolved = [];
for (const [key, code] of Object.entries(modules)) {
  for (const [, , target] of code.matchAll(/require\((["'])(\.[^"']+)\1\)/g)) {
    if (target !== './app.css' && !modules[aliases[target] ?? target]) unresolved.push(`${key} requires ${target}`);
  }
}
if (unresolved.length) throw new Error(`The interface bundle is missing modules:\n  ${unresolved.join('\n  ')}\nAdd them to modules and aliases in scripts/build-ui.mjs.`);
const body = Object.entries(modules)
  .map(([key, code]) => `${JSON.stringify(key)}:function(module,exports,require){\n${code}\n}`)
  .join(',\n');
const bundle = `/* 0rqestra interface. Third-party notices: THIRD-PARTY-LICENSE.txt */\n(()=>{'use strict';const modules={${body}};const cache={};const aliases=${JSON.stringify(aliases)};function require(name){if(name==='./app.css')return {};name=aliases[name]||name;if(cache[name])return cache[name].exports;if(!modules[name])throw Error('Unknown module '+name);const m=cache[name]={exports:{}};modules[name](m,m.exports,require);return m.exports;}require('app');})();\n`;
// Parse the whole bundle once: a syntax error (such as a name declared twice in one component) would
// otherwise only show at start as a blank window.
try {
  new vm.Script(bundle, { filename: 'app.js' });
} catch (error) {
  throw new Error(`The interface bundle does not parse: ${error.message}`, { cause: error });
}
fs.writeFileSync(path.join(outdir, 'app.js'), bundle);
fs.copyFileSync(path.join(vendor, 'THIRD-PARTY-LICENSE.txt'), path.join(outdir, 'THIRD-PARTY-LICENSE.txt'));
// App icon for the window (dist/icon.ico on Windows, dist/icon.png elsewhere) and the page favicon.
const iconDir = path.join(root, 'assets', 'icon');
for (const file of ['icon.ico', 'icon.png']) fs.copyFileSync(path.join(iconDir, file), path.join(root, 'dist', file));
fs.copyFileSync(path.join(iconDir, 'png', 'icon-32.png'), path.join(outdir, 'favicon.png'));
// The start screen and the About section show the icon at 76 px (and sharp on high-density screens).
fs.copyFileSync(path.join(iconDir, 'png', 'icon-256.png'), path.join(outdir, 'logo.png'));
console.log('Built the 0rqestra interface offline.');
