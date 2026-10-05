import { describe, it, expect, beforeEach } from 'vitest'
import { handOffPosition, claimPosition, HANDOFF_MS } from './positionHandoff'

const saved = { position: null, offset: 1200, percent: null }

describe('positionHandoff', () => {
  beforeEach(() => { claimPosition('', '') /* empty the slot */ })

  it('C2: the next mount of the target chapter gets the server position the toast offered', () => {
    handOffPosition('ed-1', 'ch-7', saved, 1000)
    expect(claimPosition('ed-1', 'ch-7', 2000)).toEqual(saved)
  })

  it('is claimed once', () => {
    handOffPosition('ed-1', 'ch-7', saved, 1000)
    claimPosition('ed-1', 'ch-7', 1000)
    expect(claimPosition('ed-1', 'ch-7', 1000)).toBeNull()
  })

  it('another book or chapter does not adopt it, and drops it', () => {
    handOffPosition('ed-1', 'ch-7', saved, 1000)
    expect(claimPosition('ed-2', 'ch-7', 1000)).toBeNull()
    expect(claimPosition('ed-1', 'ch-7', 1000)).toBeNull()
    handOffPosition('ed-1', 'ch-7', saved, 1000)
    expect(claimPosition('ed-1', 'ch-8', 1000)).toBeNull()
  })

  it('goes stale', () => {
    handOffPosition('ed-1', 'ch-7', saved, 1000)
    expect(claimPosition('ed-1', 'ch-7', 1000 + HANDOFF_MS + 1)).toBeNull()
  })
})
