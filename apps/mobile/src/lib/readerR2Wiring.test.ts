import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** R2 wiring that lives in a native-view component (ToastContext): react-dom cannot mount it, so a source guard. */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('M1 — the newer-position toast', () => {
  it('only the action label runs the action; the body dismisses (native view: not mountable here)', () => {
    const toast = read('src/context/ToastContext.tsx')
    expect(toast).toContain('onPress={hide}')
    expect(toast).toContain('onPress={() => { hide(); current.onPress?.() }}')
    expect(toast).not.toContain('current.onPress ?? hide')
  })
})
