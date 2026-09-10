import { Fragment, memo, type ReactNode } from 'react'
import { View, Text, ScrollView, StyleSheet, Platform, type TextStyle } from 'react-native'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'
import { isTableSeparator } from '../lib/markdown'

/**
 * Small self-contained markdown renderer. Its content is what an outside assistant wrote back as a
 * BookInsight (Markdown on the wire:
 * `##` headings, bullets, numbered lists, **bold**, *italic*, `inline code`, fenced code blocks,
 * blockquotes, and GFM tables). Deliberately NOT `react-native-markdown-display` — that dep is
 * unmaintained against RN 0.83 / the new architecture, and adding a native-adjacent parser is a
 * Play Data-Safety + OTA risk for zero upside here. This renderer is ~180 lines, theme-tokenised,
 * and pure-JS (OTA-safe). No raw-HTML path exists — model output is only ever tokenised as markdown.
 *
 * Divergences vs web Markdown: tables degrade to a horizontally-scrollable monospace block
 * (RN has no <table>); inline `[n]` citation markers render as plain text (the citation CHIPS below
 * the answer are the jump surface on mobile). Links render as literal text (the inline pass has no
 * link rule) — intended: answers are grounded in the book, external links are vanishingly rare.
 */

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

// One inline pass: inline code, **bold**/__bold__, *italic*/_italic_. Left-to-right alternation so a
// `**` match wins over `*` at the same position. Nested emphasis is not supported (rare in answers).
const INLINE_RE = /(`[^`]+`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)/g

interface InlineColors {
  text: string
  code: string
  codeBg: string
}

/** Splits a line into styled <Text> spans. Emphasis/code markers are stripped; everything else is literal. */
function renderInline(line: string, colors: InlineColors, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  let n = 0
  while ((m = INLINE_RE.exec(line)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyPrefix}-t${n}`}>{line.slice(last, m.index)}</Fragment>)
    if (m[1] != null) {
      out.push(
        <Text key={`${keyPrefix}-c${n}`} style={{ fontFamily: MONO, color: colors.code, backgroundColor: colors.codeBg }}>
          {m[1].slice(1, -1)}
        </Text>,
      )
    } else if (m[3] != null || m[5] != null) {
      out.push(<Text key={`${keyPrefix}-b${n}`} style={{ fontFamily: fonts.sansBold }}>{m[3] ?? m[5]}</Text>)
    } else if (m[7] != null || m[9] != null) {
      out.push(<Text key={`${keyPrefix}-i${n}`} style={{ fontStyle: 'italic' }}>{m[7] ?? m[9]}</Text>)
    }
    last = m.index + m[0].length
    n++
  }
  if (last < line.length) out.push(<Fragment key={`${keyPrefix}-t${n}`}>{line.slice(last)}</Fragment>)
  return out
}

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 19, 3: 17, 4: 15, 5: 14, 6: 13 }

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const { colors } = useTheme()
  const inline: InlineColors = { text: colors.text, code: colors.primary, codeBg: colors.border + '66' }
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let key = 0
  const paraStyle: TextStyle = { color: colors.text, fontSize: 15, lineHeight: 22, fontFamily: fonts.sans }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ``` ... ```
    const fence = line.match(/^```/)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // consume closing fence (or run off the end)
      blocks.push(
        <ScrollView
          key={key++}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.codeBlock, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: colors.text }}>{buf.join('\n')}</Text>
        </ScrollView>,
      )
      continue
    }

    // Blank line — skip (block spacing is handled by margins).
    if (line.trim() === '') { i++; continue }

    // Heading (#..######)
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      blocks.push(
        <Text key={key++} style={[styles.heading, { color: colors.text, fontSize: HEADING_SIZE[level] }]}>
          {renderInline(h[2], inline, `h${key}`)}
        </Text>,
      )
      i++
      continue
    }

    // Table: a header row of `| a | b |` immediately followed by a `---|---` separator. The separator
    // MUST itself contain a pipe (see `isTableSeparator`) so a bare `---` thematic break after a
    // pipe-containing paragraph doesn't get mis-read as a table. Degrade the whole contiguous pipe-run
    // to a monospace, horizontally scrollable block (RN has no table).
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const buf: string[] = []
      while (i < lines.length && lines[i].includes('|')) { buf.push(lines[i]); i++ }
      blocks.push(
        <ScrollView
          key={key++}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.codeBlock, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={{ fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.text }}>{buf.join('\n')}</Text>
        </ScrollView>,
      )
      continue
    }

    // Blockquote (contiguous `> ` lines)
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push(
        <View key={key++} style={[styles.quote, { borderLeftColor: colors.primary }]}>
          <Text style={[paraStyle, { color: colors.textSecondary }]}>{renderInline(buf.join('\n'), inline, `q${key}`)}</Text>
        </View>,
      )
      continue
    }

    // Unordered / ordered list (contiguous item lines)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: { marker: string; content: string }[] = []
      let idx = 1
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const ol = lines[i].match(/^\s*(\d+)\.\s+(.*)$/)
        if (ol) { items.push({ marker: `${ol[1]}.`, content: ol[2] }); idx = Number(ol[1]) + 1 }
        else { items.push({ marker: '•', content: lines[i].replace(/^\s*[-*+]\s+/, '') }); idx++ }
        i++
      }
      blocks.push(
        <View key={key++} style={styles.list}>
          {items.map((it, j) => (
            <View key={j} style={styles.listItem}>
              <Text style={[paraStyle, styles.bullet, { color: colors.textSecondary }]}>{it.marker}</Text>
              <Text style={[paraStyle, styles.listText]}>{renderInline(it.content, inline, `li${key}-${j}`)}</Text>
            </View>
          ))}
        </View>,
      )
      continue
    }

    // Paragraph: gather until a blank line or a block-starting line.
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i]); i++
    }
    blocks.push(
      <Text key={key++} style={[paraStyle, styles.para]}>{renderInline(buf.join(' '), inline, `p${key}`)}</Text>,
    )
  }

  return <View>{blocks}</View>
})

const styles = StyleSheet.create({
  heading: { fontFamily: fonts.sansBold, marginTop: 10, marginBottom: 4 },
  para: { marginBottom: 8 },
  codeBlock: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 8 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginBottom: 8 },
  list: { marginBottom: 8 },
  listItem: { flexDirection: 'row', marginBottom: 2 },
  bullet: { width: 22 },
  listText: { flex: 1 },
})
