import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.join(__dirname, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('backend supply-chain metadata is pinned and auditable', () => {
  assert.equal(manifest.packageManager, 'npm@10.8.2');
  assert.deepEqual(manifest.engines, { node: '20.x', npm: '10.x' });

  const allVersions = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  for (const [name, version] of Object.entries(allVersions)) {
    assert.doesNotMatch(version, /[~^]/, `${name} must be fully pinned`);
    assert.match(version, /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/, `${name} must use an exact semver`);
  }

  assert.equal(typeof manifest.scripts['audit:check'], 'string');
  assert.equal(typeof manifest.scripts['sbom:generate'], 'string');
});
