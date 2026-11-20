// Build 44 differs from builds 40–43 only by obsolete .gitignore entries.
// Reproduce its fingerprint rather than overriding native compatibility.
// Stop supporting this alias automatically when the native runtime changes.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SOURCE_RUNTIME = '9b7fb67cf45606f69c7f6b804b6f8bdcc8e05c9d'
export const BUILD44_RUNTIME = '93a431bfe1f2f06f56baaf727c7c1f18d3c8a877'
export const OLD_READER_IGNORE = '\n# V2 reader page: pinned foliate-js clone, generated fixtures (src/lib/v2reader/README.md)\nsrc/lib/v2reader/.vendor/\nsrc/lib/v2reader/fixtures/\n'

export function publishBuild44({ runtime, file, resolveRuntime, publish }) {
  if (runtime !== SOURCE_RUNTIME) return false
  const original = readFileSync(file, 'utf8')
  if (!original.endsWith(OLD_READER_IGNORE)) throw new Error('Unexpected mobile .gitignore; refusing build 44 OTA')
  try {
    writeFileSync(file, original.slice(0, -OLD_READER_IGNORE.length))
    if (resolveRuntime() !== BUILD44_RUNTIME) throw new Error('Build 44 fingerprint mismatch; refusing OTA')
    publish()
    return true
  } finally {
    writeFileSync(file, original)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mobile = fileURLToPath(new URL('../../apps/mobile/', import.meta.url))
  const resolveRuntime = () => JSON.parse(execFileSync(process.execPath,
    ['../../node_modules/expo-updates/bin/cli.js', 'runtimeversion:resolve', '--platform', 'android'],
    { cwd: mobile, encoding: 'utf8' })).runtimeVersion
  const published = publishBuild44({
    // Recompute from the tree instead of trusting a caller-supplied hash.
    runtime: resolveRuntime(),
    file: resolve(mobile, '.gitignore'),
    resolveRuntime,
    publish: () => execFileSync('eas', ['update', '--branch', 'production', '--platform', 'android',
      '--environment', 'production', '--message', process.argv[2] || 'Reader update for build 44',
      '--non-interactive'], { cwd: mobile, stdio: 'inherit' }),
  })
  console.log(published ? 'Published compatible OTA for build 44.' : 'Native runtime changed; build 44 alias no longer compatible, skipped.')
}
