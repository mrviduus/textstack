import ts from 'typescript'

/**
 * #1267: user-visible English written into a component instead of through `t()`, and (React Native) a touchable with
 * no accessible name or a `Modal` that Android back does not close (no `onRequestClose`). Test-only (`i18nKeys.test.ts` here, web's `missing-keys.test.ts`): parses TSX with the
 * TypeScript compiler, so code (`a < b`, generics) is never read as text.
 *
 * A string is "shown" when it is JSX text, a naming attribute (`aria-label`, `title`, `accessibilityLabel`, …), the
 * value of a JSX expression or of a shown setter/toast field, or a branch of one (`a ? 'X' : 'Y'`, `x ?? 'X'`, a
 * template's text); not the text of an `aria-hidden` element (an icon font's ligature). Two letters in a row make it
 * words; `‹`, `×`, `A+`, `1.6`, `{v}x`, `{size}px` are not. A comparison operand (`flow === 'paginated'`) and a
 * `t()` key are never shown.
 */
export interface Finding { line: number; kind: 'text' | 'unnamed' | 'noBack'; text: string }

const LETTERS = /\p{L}{2,}/u
/** Words, not a unit after a number (`{size}px`). */
const words = (s: string) => LETTERS.test(s.replace(/\bpx\b/g, ''))
const NAME_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'accessibilityLabel', 'accessibilityHint'])
/** Setters and fields whose string goes on screen. */
const SHOWN_CALLS = /^set(Heading|Error|OpenError|Restored|Toast)$/
const SHOWN_FIELDS = new Set(['message', 'actionLabel'])
const TOUCHABLES = new Set(['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback'])

/** The literal text of `e` where it reaches the screen as is (through branches and templates), else none. */
function shownTexts(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text]
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.flatMap((s) => [s.literal.text, ...shownTexts(s.expression)])]
  if (ts.isParenthesizedExpression(e)) return shownTexts(e.expression)
  if (ts.isConditionalExpression(e)) return [...shownTexts(e.whenTrue), ...shownTexts(e.whenFalse)]
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return shownTexts(e.right)
  return []
}

const tagName = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText()
const attrs = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement : n).attributes.properties

const hidden = (n: ts.JsxElement) => attrs(n).some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'aria-hidden' && a.initializer?.getText() !== '{false}')

/** Does a touchable get a name: a label, `accessible={false}`, a `<Text>` in it, or children it forwards? */
function named(n: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  for (const a of attrs(n)) {
    if (ts.isJsxSpreadAttribute(a)) return true
    const name = a.name.getText()
    if (name === 'accessibilityLabel' || name === 'aria-label') return true
    if (name === 'accessible' && a.initializer?.getText() === '{false}') return true
  }
  if (!ts.isJsxElement(n)) return false
  let text = false
  const visit = (c: ts.Node) => {
    if ((ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && tagName(c) === 'Text') text = true
    if (ts.isJsxExpression(c) && c.expression && ts.isIdentifier(c.expression) && c.expression.text === 'children') text = true
    if (!text) ts.forEachChild(c, visit)
  }
  n.children.forEach(visit)
  return text
}

/** Hard-coded shown strings (and, with `touchables`, React Native touchables with no name and modals back leaves open) in one TSX source. */
export function findHardcoded(source: string, { touchables = false } = {}): Finding[] {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: Finding[] = []
  const add = (node: ts.Node, kind: Finding['kind'], text: string) =>
    out.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, text: text.trim() })
  const check = (node: ts.Node, e: ts.Expression | undefined) => {
    for (const s of e ? shownTexts(e) : []) if (words(s)) add(node, 'text', s)
  }
  const visit = (n: ts.Node) => {
    // An icon font's ligature (`<span aria-hidden="true">check</span>`) is a glyph, not words anyone reads.
    if (ts.isJsxText(n) && words(n.text) && !(ts.isJsxElement(n.parent) && hidden(n.parent))) add(n, 'text', n.text)
    else if (ts.isJsxAttribute(n) && NAME_ATTRS.has(n.name.getText())) {
      const v = n.initializer
      if (v && ts.isStringLiteral(v)) check(n, v)
      else if (v && ts.isJsxExpression(v)) check(n, v.expression)
    } else if (ts.isJsxExpression(n) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) check(n, n.expression)
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SHOWN_CALLS.test(n.expression.text)) check(n, n.arguments[0])
    else if (ts.isPropertyAssignment(n) && SHOWN_FIELDS.has(n.name.getText())) check(n, n.initializer)
    if (touchables && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && TOUCHABLES.has(tagName(n)) && !named(n)) add(n, 'unnamed', tagName(n))
    if (touchables && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === 'Modal'
      && !attrs(n).some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'onRequestClose')) add(n, 'noBack', 'Modal')
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}
