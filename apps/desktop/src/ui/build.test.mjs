import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The interface is bundled by a script with a hand-written module list. A local import missing from
// that list compiles fine but makes the window blank at startup, so the build itself must catch it.
describe('interface bundle', () => {
  it('builds with every local import resolved', () => {
    execFileSync(process.execPath, [path.join(desktop, 'scripts', 'build-ui.mjs')], { stdio: 'pipe' });
    const bundle = fs.readFileSync(path.join(desktop, 'dist', 'renderer', 'app.js'), 'utf8');
    for (const name of ['app', 'storageKeys', 'updateGate', 'updateUI']) expect(bundle).toContain(`"${name}":function`);
  }, 60_000);
});
