import { describe, it, expect, vi } from 'vitest'
import { createResumeOpener, createResumeFlight, releaseResumeFlight } from './resumeOpener'

const unplaced = { type: 'edition' as const, slug: 'dracula', chapterSlug: null }

function setup(active = true, flight = createResumeFlight()) {
  let release!: (route: string) => void
  const resolve = vi.fn(() => new Promise<string>(r => { release = r }))
  const push = vi.fn()
  const onPending = vi.fn()
  const state = { active }
  const open = createResumeOpener({ resolve, push, isActive: () => state.active, onPending, flight })
  return { open, resolve, push, onPending, state, release: (r: string) => release(r) }
}

describe('createResumeOpener — Continue tapped while the place is being looked up', () => {
  it('ignores repeat taps while one lookup is in flight, and pushes once', async () => {
    const s = setup()
    const first = s.open(unplaced)
    void s.open(unplaced)
    void s.open(unplaced)
    expect(s.resolve).toHaveBeenCalledTimes(1)
    s.release('/reader/dracula/ch-5')
    await first
    expect(s.push).toHaveBeenCalledTimes(1)
    expect(s.push).toHaveBeenCalledWith('/reader/dracula/ch-5')
  })

  it('does not navigate if the screen left (blur/unmount) before the answer came', async () => {
    const s = setup()
    const p = s.open(unplaced)
    s.state.active = false
    s.release('/reader/dracula/ch-5')
    await p
    expect(s.push).not.toHaveBeenCalled()
  })

  it('reports which pick is pending, then clears it', async () => {
    const s = setup()
    const p = s.open(unplaced)
    expect(s.onPending).toHaveBeenLastCalledWith('edition:dracula')
    s.release('/book/dracula')
    await p
    expect(s.onPending).toHaveBeenLastCalledWith(null)
  })

  it('a pick that names its chapter navigates at once, no lookup', async () => {
    const s = setup()
    await s.open({ type: 'userbook', id: 'ub-1', chapterSlug: 'ch-2' })
    expect(s.resolve).not.toHaveBeenCalled()
    expect(s.push).toHaveBeenCalledWith('/my-books/read/ub-1/ch-2')
  })

  it('hero and list share one guard: two Continues cannot push two readers (review 2 #9)', async () => {
    const flight = createResumeFlight()
    const hero = setup(true, flight)
    const list = setup(true, flight)
    const p = hero.open(unplaced)
    await list.open({ type: 'userbook', id: 'ub-1', chapterSlug: null })
    await list.open({ type: 'userbook', id: 'ub-1', chapterSlug: 'ch-2' })
    expect(list.resolve).not.toHaveBeenCalled()
    expect(list.push).not.toHaveBeenCalled()
    hero.release('/reader/dracula/ch-5')
    await p
    expect(hero.push).toHaveBeenCalledTimes(1)
  })

  it('a hanging lookup cannot block Continue forever: the flag expires after 8s (review 3 #6)', async () => {
    let now = 1000
    const flight = createResumeFlight(() => now)
    const hung = setup(true, flight)
    void hung.open(unplaced) // never released
    const next = setup(true, flight)
    await next.open({ type: 'userbook', id: 'ub-1', chapterSlug: 'ch-2' })
    expect(next.push).not.toHaveBeenCalled()
    now += 8001
    await next.open({ type: 'userbook', id: 'ub-1', chapterSlug: 'ch-2' })
    expect(next.push).toHaveBeenCalledWith('/my-books/read/ub-1/ch-2')
  })

  it('leaving the screen frees the flag at once', async () => {
    const flight = createResumeFlight()
    const hung = setup(true, flight)
    void hung.open(unplaced)
    releaseResumeFlight(flight)
    const next = setup(true, flight)
    await next.open({ type: 'userbook', id: 'ub-1', chapterSlug: 'ch-2' })
    expect(next.push).toHaveBeenCalled()
  })

  it('a stale flight finishing late does not clear the spinner of the newer one (review 4 #6)', async () => {
    let now = 0
    const flight = createResumeFlight(() => now)
    const releases: ((r: string) => void)[] = []
    const resolve = vi.fn(() => new Promise<string>(r => { releases.push(r) }))
    const onPending = vi.fn()
    const open = createResumeOpener({ resolve, push: vi.fn(), isActive: () => true, onPending, flight })
    const first = open(unplaced)
    now += 9000 // first one expired
    const second = open({ type: 'userbook', id: 'ub-2', chapterSlug: null })
    releases[0]('/book/dracula')
    await first
    expect(onPending).toHaveBeenLastCalledWith('userbook:ub-2')
    releases[1]('/my-books/ub-2')
    await second
    expect(onPending).toHaveBeenLastCalledWith(null)
  })
})

