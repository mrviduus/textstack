// The public changelog page (#1216). Data: /changelog.json, written at web build by
// scripts/changelog-data.mjs from GitHub releases + merged PRs; plus SEED, the reader entries
// from before PRs carried a `## Public` block.

export const AREAS = ['reader', 'mobile', 'library', 'vocabulary', 'ai', 'data', 'ops', 'documentation'] as const
export type Area = (typeof AREAS)[number]
export type Kind = 'New' | 'Fix' | 'Improved' | 'Changed'
export type Where = 'Web' | 'Android'

export interface PublicBlock { title: string; where: Where[]; kind: Kind; text: string }
export interface ChangelogPr { number: number; title: string; url: string; labels: string[]; public?: PublicBlock }
export interface ChangelogRelease { tag: string | null; date: string; url: string | null; prs: ChangelogPr[] }
export interface ChangelogData { generatedAt?: string; releases: ChangelogRelease[] }

export interface ReaderEntry extends PublicBlock { date: string; area: Area | null; url?: string }

/** The first area label in release-notes order, as .github/release.yml picks the section. */
export const areaOf = (labels: string[]): Area | null => AREAS.find((a) => labels.includes(a)) ?? null

/** Reader view: every public PR plus the seed, newest first, grouped by date. */
export function readerFeed(data: ChangelogData, seed: ReaderEntry[] = SEED): [string, ReaderEntry[]][] {
  const fromPrs = data.releases.flatMap((r) =>
    r.prs.flatMap((p) => (p.public ? [{ ...p.public, date: r.date, area: areaOf(p.labels), url: p.url }] : [])),
  )
  const byDate = new Map<string, ReaderEntry[]>()
  for (const e of [...fromPrs, ...seed].sort((a, b) => b.date.localeCompare(a.date)))
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e])
  return [...byDate]
}

// Hand-picked from the frozen CHANGELOG.md when the page shipped. Only what a reader could see.
export const SEED: ReaderEntry[] = [
  { date: '2026-11-11', area: 'reader', kind: 'Fix', where: ['Android'], title: 'Read aloud in the book’s language',
    text: 'Listening to a German or Ukrainian book now uses a voice for that language, not an English one.' },
  { date: '2026-11-10', area: 'mobile', kind: 'Fix', where: ['Android'], title: 'Clear message when search fails',
    text: 'If a search cannot reach the server, the app says so and offers Retry instead of showing “No results”.' },
  { date: '2026-10-27', area: 'library', kind: 'New', where: ['Web', 'Android'], title: 'Re-upload brings your highlights back',
    text: 'Upload a book you deleted earlier and its highlights and reading history return with it.' },
  { date: '2026-10-27', area: 'library', kind: 'Improved', where: ['Web', 'Android'], title: 'Highlights keep the book’s title',
    text: 'Highlights from a deleted book stay in All highlights, marked with the book’s title.' },
  { date: '2026-10-26', area: 'library', kind: 'New', where: ['Web'], title: 'Upload very large books',
    text: 'Books over 100 MB now upload in parts, and a file that is too large says so plainly.' },
  { date: '2026-10-26', area: 'reader', kind: 'Fix', where: ['Web', 'Android'], title: 'Signing in keeps your place',
    text: 'When you sign in after reading as a guest, you continue from the page you read last.' },
  { date: '2026-10-20', area: 'reader', kind: 'Improved', where: ['Android'], title: 'Your place is saved sooner',
    text: 'The app saves your reading position half a second after you stop scrolling, so closing it loses less.' },
  { date: '2026-10-14', area: 'library', kind: 'Fix', where: ['Web'], title: 'Downloads use the book’s title',
    text: 'Downloading one of your books saves it under its title instead of “file.pdf”.' },
  { date: '2026-10-11', area: 'vocabulary', kind: 'New', where: ['Web', 'Android'], title: 'Choose which translation to keep',
    text: 'Tap a saved word whose meaning differs here: you see what you saved and can switch to this translation.' },
  { date: '2026-10-06', area: 'mobile', kind: 'New', where: ['Android'], title: 'See app updates arrive',
    text: 'A thin progress bar shows while an update downloads, and the app tells you before it restarts.' },
]
