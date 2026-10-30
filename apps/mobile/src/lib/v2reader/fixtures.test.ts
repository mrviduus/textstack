import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zipEpub } from './fixtures.mjs'

describe('v2 fixtures', () => {
  it('zipEpub_EntriesNamedLikeZipOptions_ZippedAsFilesMimetypeFirst', () => {
    const root = mkdtempSync(join(tmpdir(), 'zipepub-'))
    const dir = join(root, 'book')
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'mimetype'), 'application/epub+zip')
      // Passed in argv, zip would read these as -T plus --unzip-command="sh p" and run `sh p` to "test" the archive.
      writeFileSync(join(dir, '-T'), 'x')
      writeFileSync(join(dir, '--unzip-command=sh p'), 'x')
      writeFileSync(join(dir, 'p'), 'exit 1')
      const out = join(root, 'out.zip')
      zipEpub(dir, out)
      const [first, ...rest] = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n')
      expect(first).toBe('mimetype')
      expect(rest.sort()).toEqual(['--unzip-command=sh p', '-T', 'p'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
