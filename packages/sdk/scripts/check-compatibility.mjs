import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const root = path.resolve(pkgRoot, '..', '..')

const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const versionTs = fs.readFileSync(path.join(pkgRoot, 'src/version.ts'), 'utf8')

// Verify that CIRCUIT_COMPATIBILITY declares compatibility for this SDK version
const versionMatch = versionTs.match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!versionMatch) {
  console.error('✗ Failed to extract VERSION from src/version.ts')
  process.exit(1)
}

const sdkVersion = versionMatch[1]
if (sdkVersion !== pkgJson.version) {
  console.error(
    `✗ Version mismatch: src/version.ts declares "${sdkVersion}" but package.json declares "${pkgJson.version}"`
  )
  process.exit(1)
}

console.log(`Checking circuit compatibility for SDK version ${sdkVersion}...`)

// Check if CIRCUIT_COMPATIBILITY has an entry for sdkVersion
const regex = new RegExp(`['"]${sdkVersion}['"]\\s*:\\s*\\[([^\\]]+)\\]`)
const compatMatch = versionTs.match(regex)

if (!compatMatch) {
  console.error(`✗ CIRCUIT_COMPATIBILITY in src/version.ts missing entry for current SDK version "${sdkVersion}"`)
  process.exit(1)
}

const supported = compatMatch[1]
  .split(',')
  .map((s) => s.trim().replace(/['"]/g, ''))
  .filter(Boolean)

if (supported.length === 0) {
  console.error(`✗ Empty supported circuit versions for SDK version "${sdkVersion}"`)
  process.exit(1)
}

// Every SDK version must support at least N and N-1
if (supported.length < 2 && sdkVersion !== '0.1.0') {
  console.warn(`⚠ SDK version "${sdkVersion}" declares fewer than 2 supported circuit versions (N, N-1 policy).`)
}

console.log(`✓ SDK ${sdkVersion} declared circuit compatibility: ${JSON.stringify(supported)}`)
