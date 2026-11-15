import ts from 'typescript'

/**
 * #1267: user-visible English written into a component instead of through `t()`, and (React Native) a touchable with
 * no accessible name or a `Modal` that Android back does not close (no `onRequestClose`). Test-only
 * (`i18nKeys.test.ts` here, web's `missing-keys.test.ts`): parses TSX with the TypeScript compiler, so code (`a < b`,
 * generics) is never read as text.
 *
 * A string is "shown" when it is JSX text; the value of a naming prop on any element (`aria-label`, `title`, `alt`,
 * `placeholder`, `accessibilityLabel`/`Hint`, or any prop named `…Label`, `…Title`, `…Text`, `…Message`,
 * `…Placeholder`, e.g. `backLabel="Back"`); the default of a parameter so named (`prevLabel = 'Previous'`); a JSX
 * expression's value; a shown setter's or toast field's value; an `Alert.alert` title or message; or a branch of one
 * (`a ? 'X' : 'Y'`, `x ?? 'X'`, `'X' + y`, a template's text). Not the text of an element `aria-hidden` (true): an icon
 * font's ligature. Two letters in a row make it words; `‹`, `×`, `A+`, `1.6`, `{v}x`, `{size}px` are not. A comparison
 * operand (`flow === 'paginated'`) and a `t()` key are never shown.
 *
 * Out of reach (no data flow; the self-test lists them as known non-detections): a string passed to a local helper that
 * renders it (`label('THEME')`), a module constant rendered by name (`{IDLE}`), a value map rendered by lookup
 * (`{ serif: 'Serif' }[f]`).
 */
export interface Finding { line: number; kind: 'text' | 'unnamed' | 'noBack'; text: string }

const LETTERS = /\p{L}{2,}/u
/** Words, not a unit after a number (`{size}px`). */
const words = (s: string) => LETTERS.test(s.replace(/\bpx\b/g, ''))
/** Props (and parameters) whose string value is shown or spoken. */
const NAMING = /^(aria-label|title|placeholder|alt|label|accessibilityLabel|accessibilityHint)$|(Label|Title|Text|Message|Placeholder)$/
/** Setters and fields whose string goes on screen. */
const SHOWN_CALLS = /^set(Heading|Error|OpenError|Restored|Toast)$/
const SHOWN_FIELDS = new Set(['message', 'actionLabel'])
const TOUCHABLES = new Set(['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback'])

/** The literal text of `e` where it reaches the screen as is (through branches, concatenation and templates), else none. */
function shownTexts(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text]
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.flatMap((s) => [s.literal.text, ...shownTexts(s.expression)])]
  if (ts.isParenthesizedExpression(e)) return shownTexts(e.expression)
  if (ts.isConditionalExpression(e)) return [...shownTexts(e.whenTrue), ...shownTexts(e.whenFalse)]
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...shownTexts(e.left), ...shownTexts(e.right)]
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return shownTexts(e.right)
  return []
}

type El = ts.JsxElement | ts.JsxSelfClosingElement
const isEl = (n: ts.Node): n is El => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)
const tagName = (n: El) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText()
const attrs = (n: El) => (ts.isJsxElement(n) ? n.openingElement : n).attributes.properties
const attr = (n: El, name: string) => attrs(n).find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name)

/** `aria-hidden`, `aria-hidden="true"` or `aria-hidden={true}`: never `"false"` or an expression. */
const hidden = (n: El) => {
  const a = attr(n, 'aria-hidden')
  return !!a && (!a.initializer || ['"true"', "'true'", '{true}'].includes(a.initializer.getText()))
}

/**
 * Does a touchable get a name: a label (not an optional prop that has no default: it may be undefined),
 * `accessible={false}`, a spread, a `<Text>` in it, or children it forwards?
 */
function named(n: El, mayBeUndefined: Set<string>): boolean {
  for (const a of attrs(n)) {
    if (ts.isJsxSpreadAttribute(a)) return true
    const name = a.name.getText()
    if (name === 'accessibilityLabel' || name === 'aria-label') {
      const v = a.initializer
      const id = v && ts.isJsxExpression(v) && v.expression && ts.isIdentifier(v.expression) ? v.expression.text : null
      return !(id && mayBeUndefined.has(id))
    }
    if (name === 'accessible' && a.initializer?.getText() === '{false}') return true
  }
  if (!ts.isJsxElement(n)) return false
  let text = false
  const visit = (c: ts.Node) => {
    if (isEl(c) && tagName(c) === 'Text') text = true
    if (ts.isJsxExpression(c) && c.expression && ts.isIdentifier(c.expression) && c.expression.text === 'children') text = true
    if (!text) ts.forEachChild(c, visit)
  }
  n.children.forEach(visit)
  return text
}

/**
 * The names that may be undefined where used as a label: declared optional in the file's types (`x?: string`), with no
 * default where destructured (`{ x = … }`) and never assigned (`x ??= …`, `x = …`).
 */
function optionalWithoutDefault(file: ts.SourceFile): Set<string> {
  const optional = new Set<string>()
  const defaulted = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isPropertySignature(n) && n.questionToken) optional.add(n.name.getText())
    if (ts.isBindingElement(n) && n.initializer) defaulted.add(n.name.getText())
    if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left)
      && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(n.operatorToken.kind)) defaulted.add(n.left.text)
    ts.forEachChild(n, visit)
  }
  visit(file)
  return new Set([...optional].filter((x) => !defaulted.has(x)))
}

/** Hard-coded shown strings (and, with `touchables`, React Native touchables with no name and modals back leaves open) in one TSX source. */
export function findHardcoded(source: string, { touchables = false } = {}): Finding[] {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const mayBeUndefined = optionalWithoutDefault(file)
  const out: Finding[] = []
  const add = (node: ts.Node, kind: Finding['kind'], text: string) =>
    out.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, text: text.trim() })
  const check = (node: ts.Node, e: ts.Expression | undefined) => {
    for (const s of e ? shownTexts(e) : []) if (words(s)) add(node, 'text', s)
  }
  const visit = (n: ts.Node) => {
    // An icon font's ligature (`<span aria-hidden="true">check</span>`) is a glyph, not words anyone reads.
    if (ts.isJsxText(n) && words(n.text) && !(ts.isJsxElement(n.parent) && hidden(n.parent))) add(n, 'text', n.text)
    else if (ts.isJsxAttribute(n) && NAMING.test(n.name.getText())) {
      const v = n.initializer
      if (v && ts.isStringLiteral(v)) check(n, v)
      else if (v && ts.isJsxExpression(v)) check(n, v.expression)
    } else if (ts.isJsxExpression(n) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) check(n, n.expression)
    else if (ts.isBindingElement(n) && n.initializer && NAMING.test(n.name.getText())) check(n, n.initializer)
    else if (ts.isParameter(n) && n.initializer && ts.isIdentifier(n.name) && NAMING.test(n.name.text)) check(n, n.initializer)
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SHOWN_CALLS.test(n.expression.text)) check(n, n.arguments[0])
    else if (ts.isCallExpression(n) && n.expression.getText() === 'Alert.alert') n.arguments.slice(0, 2).forEach((a) => check(n, a))
    else if (ts.isPropertyAssignment(n) && SHOWN_FIELDS.has(n.name.getText())) check(n, n.initializer)
    if (touchables && isEl(n) && TOUCHABLES.has(tagName(n)) && !named(n, mayBeUndefined)) add(n, 'unnamed', tagName(n))
    if (touchables && isEl(n) && tagName(n) === 'Modal' && !attr(n, 'onRequestClose')) add(n, 'noBack', 'Modal')
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}
