import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const manifestPath = path.join(pkgRoot, 'manifests', 'manifest.json')

if (!fs.existsSync(manifestPath)) {
  console.error(`✗ Manifest file not found at ${manifestPath}. Run npm run manifest:generate first.`)
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
let failures = 0

for (const [relPath, expected] of Object.entries(manifest.artifacts)) {
  const fullPath = path.join(pkgRoot, relPath)
  if (!fs.existsSync(fullPath)) {
    console.error(`✗ Missing artifact: ${relPath}`)
    failures++
    continue
  }

  const content = fs.readFileSync(fullPath)
  const actualSha256 = crypto.createHash('sha256').update(content).digest('hex')
  const actualSha512 = crypto.createHash('sha512').update(content).digest('hex')

  if (actualSha256 !== expected.sha256) {
    console.error(`✗ SHA256 mismatch for ${relPath}: expected ${expected.sha256}, got ${actualSha256}`)
    failures++
  }
  if (actualSha512 !== expected.sha512) {
    console.error(`✗ SHA512 mismatch for ${relPath}: expected ${expected.sha512}, got ${actualSha512}`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\nManifest verification FAILED with ${failures} error(s).`)
  process.exit(1)
}

console.log(`✓ Verified ${Object.keys(manifest.artifacts).length} artifacts against manifests/manifest.json.`)
