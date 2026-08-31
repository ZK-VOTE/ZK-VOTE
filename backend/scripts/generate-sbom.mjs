import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactDir = path.join(repoRoot, '.artifacts');
const sbomPath = path.join(artifactDir, 'sbom-backend.json');

mkdirSync(artifactDir, { recursive: true });

const output = execSync(
  'npm ls --all --json --depth=999',
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const doc = {
  name: 'zkvote-backend',
  generatedAt: new Date().toISOString(),
  packageManager: 'npm@10.8.2',
  nodeVersion: process.version,
  dependencyTree: JSON.parse(output),
};

writeFileSync(sbomPath, JSON.stringify(doc, null, 2));
console.log(`SBOM written to ${sbomPath}`);
