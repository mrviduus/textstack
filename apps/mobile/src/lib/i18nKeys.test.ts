import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import en from '../../../../packages/shared/src/i18n/en.json'
import { findHardcoded } from './i18nHardcoded'

/**
 * Every literal translation key used in the mobile app must resolve to a string.
 *
 * `t()` returns the KEY when it misses, so a missing entry compiles, renders and
 * passes review while showing the reader `library.firstBook.title`. The web app
 * had three such holes when this was written, including its entire command
 * palette.
 *
 * **Mobile and web have separate locale files** — this one checks
 * `packages/shared/src/i18n/en.json`, web's twin checks
 * `apps/web/src/locales/en.json`. A key present in one says nothing about the
 * other, and checking a source tree against the wrong file reports several
 * hundred false misses.
 *
 * Two call shapes exist: `t('a.b')` from the `useLanguage()` hook, and
 * `t(language, 'a.b')` from the shared helper. Both are matched. Keys built at
 * runtime are not, and cannot be — that limit is stated rather than papered over.
 */

const ROOTS = [resolve(__dirname, '../..', 'src'), resolve(__dirname, '../..', 'app')]
const LITERAL_T = /\bt\(\s*(?:language\s*,\s*)?'([a-zA-Z][\w.]*)'\s*[),]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__mocks__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function resolveKey(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en as unknown,
  )
}

describe('mobile i18n keys', () => {
  const files = ROOTS.flatMap(r => walk(r))

  it('scans a plausible number of files', () => {
    // Without this the walk could silently find nothing and the suite would
    // pass for the worst possible reason.
    expect(files.length).toBeGreaterThan(50)
  })

  it('every literal key resolves to a string', () => {
    const missing: string[] = []
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(LITERAL_T)) {
        // An object at the path counts as missing: `t()` can only return a
        // string, so asking for a branch renders the key. Web shipped exactly
        // that — `t('highlights.empty')` where the locale held { title, … }.
        if (typeof resolveKey(m[1]) !== 'string') {
          missing.push(`${file.split('/apps/mobile/')[1]} → ${m[1]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

/**
 * #1267: the V2 reader's host files (and the legacy bars, action bar and sheets it reuses) say nothing in English
 * of their own: every shown string goes through `t()`, every touchable has a name, every sheet closes on back
 * (i18nHardcoded.ts). A new hard-coded string, an icon-only button without `accessibilityLabel` or a `Modal` without
 * `onRequestClose` fails here, by file and line.
 */
const READER_DIR = resolve(__dirname, '../components/reader')
const READER_HOST_FILES = [
  ...readdirSync(READER_DIR).filter(f => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f)).map(f => join(READER_DIR, f)),
  ...['SelectionActionBar', 'HighlightNoteModal', 'TranslationSheet', 'ExplanationSheet', 'reader/ReaderTopBar', 'reader/ReaderFooter']
    .map(f => resolve(__dirname, `../components/${f}.tsx`)),
]

describe('V2 reader host: no hard-coded strings, no unnamed controls, back closes every sheet (#1267)', () => {
  it('scans the V2 host files', () => {
    expect(READER_HOST_FILES.length).toBeGreaterThan(8)
  })

  it('every shown string goes through t(), every touchable has a name', () => {
    const found = READER_HOST_FILES.flatMap(f =>
      findHardcoded(readFileSync(f, 'utf8'), { touchables: true }).map(x => `${f.split('/src/')[1]}:${x.line} ${x.kind} ${x.text}`))
    expect(found).toEqual([])
  })

  it('the detector: each shown shape is found, keys and comparisons are not', () => {
    const src = `
      interface Props { backLabel?: string; tocLabel?: string; title: string }
      export const A = ({ t, flow, name, backLabel, tocLabel, prevLabel = 'Previous chapter' }: Props) => {
        tocLabel ??= t('reader.chrome.contents')
        return (
        <View>
          <Text>Pick book</Text>
          <Text>{flow === 'paginated' ? 'Scrolled' : t('reader.v2.paginated')}</Text>
          <Text>{\`Not synced: \${name}\`}</Text>
          <Text>{name ?? 'The book'}</Text>
          <Text>{'Saved ' + name}</Text>
          <Pressable accessibilityLabel="Close it" />
          <TouchableOpacity onPress={go}><Ionicons name="close" /></TouchableOpacity>
          <TouchableOpacity onPress={go}><Text>{t('reader.v2.pickBook')}</Text></TouchableOpacity>
          <TouchableOpacity onPress={go} accessibilityLabel={backLabel}><Ionicons name="back" /></TouchableOpacity>
          <TouchableOpacity onPress={go} accessibilityLabel={tocLabel}><Ionicons name="list" /></TouchableOpacity>
          <Pressable accessible={false} onPress={go} />
          <ReaderTopBar backLabel="Back" bookTitle={name} chapterTitle="" />
          <Text>{t('reader.v2.pick')} {size}px ‹ ×</Text>
          <span aria-hidden="true">check</span>
          <span aria-hidden="false">Shown</span>
          <Modal visible onRequestClose={close}><View /></Modal>
          <Modal visible><View /></Modal>
          {label('THEME')}
          <Text>{IDLE}</Text>
          <Text>{({ serif: 'Serif' })[family]}</Text>
        </View>
      )}
      showToast({ message: 'Could not save word.' })
      setHeading(\`Opening \${name}\`)
      Alert.alert('Delete book?', 'It cannot be undone.')
      if (a < b && c > d) go('Not shown')
    `
    expect(findHardcoded(src, { touchables: true }).map(x => `${x.kind} ${x.text}`)).toEqual([
      'text Previous chapter', 'text Pick book', 'text Scrolled', 'text Not synced:', 'text The book', 'text Saved',
      'text Close it', 'unnamed TouchableOpacity', 'unnamed TouchableOpacity', 'text Back', 'text Shown', 'noBack Modal',
      // Known non-detections (no data flow): a helper's argument `label('THEME')`, a constant `{IDLE}`, a map's value.
      'text Could not save word.', 'text Opening', 'text Delete book?', 'text It cannot be undone.',
    ])
  })
})
