/**
 * A translated template with its `{name}` slots filled (#1267). The values are put in as they are (a function
 * replacer: a `$&` in a book's title is text, not a pattern); an unknown slot is left.
 */
export const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (slot, k: string) => (k in vars ? String(vars[k]) : slot))
