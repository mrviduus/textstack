import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILD44_RUNTIME, OLD_READER_IGNORE, SOURCE_RUNTIME, publishBuild44 } from './mobile-ota-build44.mjs'

const dirs = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ota-build44-'))
  dirs.push(dir)
  const file = join(dir, '.gitignore')
  const original = 'node_modules/\n/android\n' + OLD_READER_IGNORE
  writeFileSync(file, original)
  return { file, original, runtime: SOURCE_RUNTIME, resolveRuntime: vi.fn(() => BUILD44_RUNTIME), publish: vi.fn() }
}

describe('build 44 OTA compatibility', () => {
  it('publishes with the historical ignore entries and restores the tree', () => {
    const args = setup()
    args.publish = vi.fn(() => expect(readFileSync(args.file, 'utf8')).toBe('node_modules/\n/android\n'))
    expect(publishBuild44(args)).toBe(true)
    expect(args.publish).toHaveBeenCalledOnce()
    expect(readFileSync(args.file, 'utf8')).toBe(args.original)
  })

  it('never publishes after a native runtime change', () => {
    const args = setup()
    expect(publishBuild44({ ...args, runtime: 'new-native-runtime' })).toBe(false)
    expect(args.resolveRuntime).not.toHaveBeenCalled()
    expect(args.publish).not.toHaveBeenCalled()
    expect(readFileSync(args.file, 'utf8')).toBe(args.original)
  })

  it.each(['resolve', 'publish'])('restores .gitignore when %s fails', (step) => {
    const args = setup()
    args[step === 'resolve' ? 'resolveRuntime' : 'publish'] = () => { throw new Error('failure') }
    expect(() => publishBuild44(args)).toThrow('failure')
    expect(readFileSync(args.file, 'utf8')).toBe(args.original)
  })

  it('blocks an unexpected fingerprint and restores .gitignore', () => {
    const args = setup()
    args.resolveRuntime.mockReturnValue('unknown')
    expect(() => publishBuild44(args)).toThrow('fingerprint mismatch')
    expect(args.publish).not.toHaveBeenCalled()
    expect(readFileSync(args.file, 'utf8')).toBe(args.original)
  })

  it('blocks changes to the historical ignore entries', () => {
    const args = setup()
    writeFileSync(args.file, 'changed')
    expect(() => publishBuild44(args)).toThrow('Unexpected mobile .gitignore')
    expect(args.publish).not.toHaveBeenCalled()
    expect(readFileSync(args.file, 'utf8')).toBe('changed')
  })
})
