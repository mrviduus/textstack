import { describe, expect, it } from 'vitest'
import { DISK_FULL, NOT_READABLE, hostError } from './hostErrors'

/** A translator that marks what it said (#1267: the two messages are keys, said through it). */
const t = (k: string) => `T:${k}`

describe('v2 Android host errors (#1080 item 6)', () => {
  it.each([
    ['the picker copy', new Error('java.io.IOException: sendfile failed: ENOSPC (No space left on device)')],
    ['a save', new Error('Error code 13: database or disk is full (SQLITE_FULL)')],
    ['a quota', Object.assign(new Error('quota'), { name: 'QuotaExceededError' })],
  ])('aFullDisk_%s_IsTheStorageMessage', (_, e) => {
    expect(hostError(e, t)).toBe(`T:${DISK_FULL}`)
  })

  it.each([
    ['the page read (open-failed text)', 'open: NotReadableError: The requested file could not be read'],
    ['a DOMException-like name', Object.assign(new Error('could not be read'), { name: 'NotReadableError' })],
  ])('notReadable_%s_ItsOwnMessage_NotDiskFull', (_, e) => {
    expect(hostError(e, t)).toBe(`T:${NOT_READABLE}`)
  })

  it('theTwoMessages_SaidThroughTheCallersT_AnythingElseNot (#1267)', () => {
    expect(hostError(new Error('ENOSPC'), t)).toBe(`T:${DISK_FULL}`)
    expect(hostError('NotReadableError', t)).toBe(`T:${NOT_READABLE}`)
    expect(hostError('not a zip', t)).toBe('not a zip')
  })

  it('anythingElse_ShownAsItIs', () => {
    expect(hostError('not a zip', t)).toBe('not a zip')
    expect(hostError(new TypeError('boom'), t)).toBe('TypeError: boom')
  })
})
