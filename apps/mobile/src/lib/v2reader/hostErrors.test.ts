import { describe, expect, it } from 'vitest'
import { DISK_FULL, hostError } from './hostErrors'

describe('v2 Android host errors (#1080 item 6)', () => {
  it.each([
    ['the picker copy', new Error('java.io.IOException: sendfile failed: ENOSPC (No space left on device)')],
    ['the page read (open-failed text)', 'open: NotReadableError: The requested file could not be read'],
    ['a DOMException-like name', Object.assign(new Error('could not be read'), { name: 'NotReadableError' })],
    ['a save', new Error('Error code 13: database or disk is full (SQLITE_FULL)')],
  ])('aFullDisk_%s_IsAHumanMessage', (_, e) => {
    expect(hostError(e)).toBe(DISK_FULL)
  })

  it('anythingElse_ShownAsItIs', () => {
    expect(hostError('not a zip')).toBe('not a zip')
    expect(hostError(new TypeError('boom'))).toBe('TypeError: boom')
  })
})
