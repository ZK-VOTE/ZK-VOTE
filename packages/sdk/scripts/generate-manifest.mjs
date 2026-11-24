import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')

const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const manifestsDir = path.join(pkgRoot, 'manifests')
if (!fs.existsSync(manifestsDir)) {
  fs.mkdirSync(manifestsDir, { recursive: true })
}

const distDir = path.join(pkgRoot, 'dist')
const artifacts = {}
const checksumsLines = []

function hashFile(filePath, relPath) {
  const content = fs.readFileSync(filePath)
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')
  const sha512 = crypto.createHash('sha512').update(content).digest('hex')
  artifacts[relPath] = {
    sha256,
    sha512,
    size: content.length,
  }
  checksumsLines.push(`${sha256}  ${relPath}`)
}

if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir)
  for (const f of files) {
    const full = path.join(distDir, f)
    if (fs.statSync(full).isFile()) {
      hashFile(full, `dist/${f}`)
    }
  }
} else {
  // If dist not built yet, include placeholder baseline for source manifest
  console.warn('Notice: dist/ directory not found. Generating baseline manifest from src.')
  const srcDir = path.join(pkgRoot, 'src')
  const files = fs.readdirSync(srcDir)
  for (const f of files) {
    const full = path.join(srcDir, f)
    if (fs.statSync(full).isFile()) {
      hashFile(full, `src/${f}`)
    }
  }
}

// Extract circuit compatibility from version.ts
let circuitCompatibility = {
  '1.0.0': ['1.0', '0.9'],
}
try {
  const versionTs = fs.readFileSync(path.join(pkgRoot, 'src/version.ts'), 'utf8')
  const match = versionTs.match(/CIRCUIT_COMPATIBILITY\s*=\s*({[\s\S]*?}\s*as\s*const|{[\s\S]*?})/m)
  if (match) {
    // Basic parser for compatibility mapping
    const cleaned = match[1].replace(/as\s+const/g, '').replace(/'/g, '"')
    circuitCompatibility = JSON.parse(cleaned)
  }
} catch {
  // Use default if parsing fails
}

const manifest = {
  schemaVersion: '1.0.0',
  packageName: pkgJson.name,
  version: pkgJson.version,
  generatedAt: new Date().toISOString(),
  circuitCompatibility,
  artifacts,
  provenance: {
    builder: 'GitHub Actions / Sigstore Cosign OIDC',
    signatureType: 'npm --provenance',
    verificationPolicy: 'https://docs.npmjs.com/generating-provenance-statements',
  },
}

fs.writeFileSync(path.join(manifestsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(manifestsDir, 'checksums.sha256'), checksumsLines.join('\n') + '\n')

console.log(`✓ Manifest generated with ${Object.keys(artifacts).length} artifacts in manifests/manifest.json`)
