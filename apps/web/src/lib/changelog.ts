// The public changelog page (#1216). Data: /changelog.json, written at web build by
// tools/checks/changelog-data.mjs from GitHub releases + merged PRs; plus SEED, the reader entries
// from before PRs carried a `## Public` block.

export const AREAS = ['reading', 'library', 'highlights', 'vocabulary', 'assistant', 'account', 'data', 'ops', 'documentation'] as const
export type Area = (typeof AREAS)[number]
export type Kind = 'New' | 'Fix' | 'Improved' | 'Changed'
export type Where = 'Web' | 'Android'

export interface PublicBlock { title: string; where: Where[]; kind: Kind; text: string }
export interface ChangelogPr { number: number; title: string; url: string; labels: string[]; mergedAt: string; public?: PublicBlock }
export interface ChangelogData { generatedAt?: string; prs: ChangelogPr[] }

export interface ReaderEntry extends PublicBlock { date: string; area: Area | null; url?: string }

/** The first area label in release-notes order, as .github/release.yml picks the section. */
export const areaOf = (labels: string[]): Area | null => AREAS.find((a) => labels.includes(a)) ?? null

/** Monday (UTC) of the week a date falls in, as YYYY-MM-DD. */
export function weekOf(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Items grouped by week, newest week first; items keep their order. */
export function byWeek<T>(items: T[], dateOf: (t: T) => string): [string, T[]][] {
  const weeks = new Map<string, T[]>()
  for (const i of items) {
    const w = weekOf(dateOf(i))
    weeks.set(w, [...(weeks.get(w) ?? []), i])
  }
  return [...weeks].sort(([a], [b]) => b.localeCompare(a))
}

/** Reader view: public PRs plus the seed, newest first. */
export function readerEntries(data: ChangelogData, seed: ReaderEntry[] = SEED): ReaderEntry[] {
  const fromPrs = data.prs.flatMap((p) =>
    p.public ? [{ ...p.public, date: p.mergedAt.slice(0, 10), area: areaOf(p.labels), url: p.url }] : [],
  )
  return [...fromPrs, ...seed].sort((a, b) => b.date.localeCompare(a.date))
}

// Hand-picked from the frozen CHANGELOG.md when the page shipped. Only what a reader could see.
export const SEED: ReaderEntry[] = [
  { date: '2026-11-11', area: 'reading', kind: 'Fix', where: ['Android'], title: 'Read aloud in the book’s language',
    text: 'Listening to a German or Ukrainian book now uses a voice for that language, not an English one.' },
  { date: '2026-11-10', area: 'library', kind: 'Fix', where: ['Android'], title: 'Clear message when search fails',
    text: 'If a search cannot reach the server, the app says so and offers Retry instead of showing “No results”.' },
  { date: '2026-10-27', area: 'highlights', kind: 'New', where: ['Web', 'Android'], title: 'Re-upload brings your highlights back',
    text: 'Upload a book you deleted earlier and its highlights and reading history return with it.' },
  { date: '2026-10-27', area: 'highlights', kind: 'Improved', where: ['Web', 'Android'], title: 'Highlights keep the book’s title',
    text: 'Highlights from a deleted book stay in All highlights, marked with the book’s title.' },
  { date: '2026-10-26', area: 'library', kind: 'New', where: ['Web'], title: 'Upload very large books',
    text: 'Books over 100 MB now upload in parts, and a file that is too large says so plainly.' },
  { date: '2026-10-26', area: 'reading', kind: 'Fix', where: ['Web', 'Android'], title: 'Signing in keeps your place',
    text: 'When you sign in after reading as a guest, you continue from the page you read last.' },
  { date: '2026-10-20', area: 'reading', kind: 'Improved', where: ['Android'], title: 'Your place is saved sooner',
    text: 'The app saves your reading position half a second after you stop scrolling, so closing it loses less.' },
  { date: '2026-10-14', area: 'library', kind: 'Fix', where: ['Web'], title: 'Downloads use the book’s title',
    text: 'Downloading one of your books saves it under its title instead of “file.pdf”.' },
  { date: '2026-10-11', area: 'vocabulary', kind: 'New', where: ['Web', 'Android'], title: 'Choose which translation to keep',
    text: 'Tap a saved word whose meaning differs here: you see what you saved and can switch to this translation.' },
  { date: '2026-10-06', area: 'ops', kind: 'New', where: ['Android'], title: 'See app updates arrive',
    text: 'A thin progress bar shows while an update downloads, and the app tells you before it restarts.' },
]

// The move to V2 (#1013), in reader words. Finished 2026-11-17 (M6); kept so a reader sees the
// whole road. No more updates.
export type StepState = 'done' | 'now' | 'next'
export interface MoveStep { title: string; text: string; state: StepState }

export const MOVE_UPDATED = '2026-11-17'

export const MOVE_STEPS: MoveStep[] = [
  { state: 'done', title: 'A new home for your data',
    text: 'A new, simpler database for your library, reading positions, highlights and words. It runs beside the old one.' },
  { state: 'done', title: 'The apps can use it',
    text: 'The web app and the Android app can read and save everything in the new home. It stays off for readers until the switch.' },
  { state: 'done', title: 'Moving your data, rehearsed',
    text: 'We copied real backups into the new home three times and checked that every book, highlight and word arrived.' },
  { state: 'done', title: 'A new reading screen',
    text: 'It opens the book file straight from your device: no waiting, no network, no account needed. On the web and Android.' },
  { state: 'done', title: 'The new reading screen catches up',
    text: 'Menus, page turns, highlights with colours and notes, your reading position on every device, listening, the words you saved marked in the text, pictures full screen, bookmarks, search in the book, and talking a chapter over with your assistant.' },
  { state: 'done', title: 'The switch',
    text: 'Your books, reading positions, highlights and words moved to the new home on 17 November, and the new reading screen opens every book, saved articles too. You keep reading where you were.' },
  { state: 'done', title: 'Old parts retire',
    text: 'The old reading screen, the old database and the public catalogue are gone, since 17 November. TextStack is your own library, nothing else.' },
  { state: 'done', title: 'PDF books on the new reading screen',
    text: 'PDF books open in the new reading screen, with their pages as they are.' },
  { state: 'done', title: 'Tests on real phones',
    text: 'Very large books, a full phone, older Android versions.' },
]

/** Questions still open about the move, in reader words. Nothing private goes here. */
export const MOVE_OPEN: string[] = []

/** Percent of the road: a step in progress counts as half. */
export const moveProgress = (steps: MoveStep[]): number =>
  steps.length ? Math.round((100 * steps.reduce((n, s) => n + (s.state === 'done' ? 1 : s.state === 'now' ? 0.5 : 0), 0)) / steps.length) : 0
