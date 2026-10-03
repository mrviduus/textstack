import { describe, it, expect } from 'vitest'
import { chapterEndModel, discussAfterSave, type ChapterEndInput, type ChapterEndLabels } from './chapterEnd'

const labels: ChapterEndLabels = {
  next: 'Next: {title}',
  nextUntitled: 'Next chapter',
  prevUntitled: 'Previous chapter',
  finished: 'You finished {book}',
  finishedGeneric: 'You finished the book',
  discuss: 'Discuss this chapter',
  reviewWords: n => `Review ${n} words`,
  library: 'Back to library',
  unavailable: 'Offline',
  retry: 'Try again',
}

const chapters = [
  { slug: 'c1', title: 'Down the Rabbit-Hole' },
  { slug: 'c2', title: 'The Pool of Tears' },
  { slug: 'c3', title: 'A Caucus-Race' },
]

const input = (o: Partial<ChapterEndInput> = {}): ChapterEndInput => ({
  chapters,
  chapterTitle: 'The Pool of Tears',
  prev: { slug: 'c1', title: 'Down the Rabbit-Hole' },
  next: { slug: 'c3', title: 'A Caucus-Race' },
  bookTitle: 'Alice',
  canDiscuss: true,
  savedWords: 0,
  error: false,
  busy: false,
  ...o,
})

describe('chapterEndModel — a chapter with a next one', () => {
  it('names the next chapter, where it sits in the book, and the previous one', () => {
    const m = chapterEndModel(input(), labels)
    expect(m.finished).toBe(false)
    expect(m.title).toBe('The Pool of Tears')
    expect(m.next).toEqual({ slug: 'c3', label: 'Next: A Caucus-Race ›', counter: '3 / 3' })
    expect(m.prev).toEqual({ slug: 'c1', label: '‹ Down the Rabbit-Hole' })
    expect(m.discuss).toBe('✦ Discuss this chapter')
    expect(m.library).toBeNull()
    expect(m.reviewWords).toBeNull()
  })

  it('falls back to the chapter list for a title the link does not carry', () => {
    const m = chapterEndModel(input({ next: { slug: 'c3' }, prev: { slug: 'c1' } }), labels)
    expect(m.next!.label).toBe('Next: A Caucus-Race ›')
    expect(m.prev!.label).toBe('‹ Down the Rabbit-Hole')
  })

  it('still offers Next before the chapter list has loaded — just without the counter', () => {
    const m = chapterEndModel(input({ chapters: [], next: { slug: 'c3' }, prev: null }), labels)
    expect(m.next).toEqual({ slug: 'c3', label: 'Next chapter ›', counter: null })
    expect(m.prev).toBeNull()
  })

  it('hides Discuss for a chapter that cannot be reviewed', () => {
    expect(chapterEndModel(input({ canDiscuss: false }), labels).discuss).toBeNull()
  })

  it('shows the offline error with a retry only when the open failed', () => {
    expect(chapterEndModel(input(), labels).error).toBeNull()
    const m = chapterEndModel(input({ error: true }), labels)
    expect(m.error).toBe('Offline')
    expect(m.retry).toBe('Try again')
  })
})

describe('chapterEndModel — the last chapter', () => {
  it('says the book is finished and offers Discuss, the words and the library', () => {
    const m = chapterEndModel(input({ next: null, savedWords: 4 }), labels)
    expect(m.finished).toBe(true)
    expect(m.title).toBe('You finished Alice')
    expect(m.next).toBeNull()
    expect(m.discuss).toBe('✦ Discuss this chapter')
    expect(m.reviewWords).toBe('Review 4 words')
    expect(m.library).toBe('Back to library')
  })

  it('offers no word review when none were saved', () => {
    expect(chapterEndModel(input({ next: null, savedWords: 0 }), labels).reviewWords).toBeNull()
  })

  it('has a title before the book title has loaded', () => {
    expect(chapterEndModel(input({ next: null, bookTitle: null }), labels).title).toBe('You finished the book')
  })
})

describe('discussAfterSave', () => {
  it('opens the assistant only after the progress write has finished', async () => {
    // The server refuses a review beyond the saved progress, so the order is the feature.
    const log: string[] = []
    let finishSave!: () => void
    const save = () => new Promise<void>(r => { finishSave = () => { log.push('saved'); r() } })
    const done = discussAfterSave(save, () => { log.push('launched') })
    await Promise.resolve()
    expect(log).toEqual([])
    finishSave()
    await done
    expect(log).toEqual(['saved', 'launched'])
  })

  it('still opens the assistant when the save fails or had nothing to send', async () => {
    const log: string[] = []
    await discussAfterSave(() => Promise.reject(new Error('offline')), () => { log.push('a') })
    await discussAfterSave(() => undefined, () => { log.push('b') })
    expect(log).toEqual(['a', 'b'])
  })
})
