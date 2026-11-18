// Draws ```mermaid blocks as diagrams. The library loads only on pages that have one.
// ponytail: the diagram keeps the theme it was drawn in until the next page load; redraw on theme change if that bothers anyone.
const blocks = document.querySelectorAll('pre[data-language="mermaid"]')
if (blocks.length) {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral',
  })
  for (const [i, pre] of [...blocks].entries()) {
    const figure = pre.closest('.expressive-code') ?? pre
    // The copy button carries the source, with DEL (\x7f) between lines.
    const source = figure.querySelector('[data-code]')?.dataset.code.replaceAll('\u007f', '\n') ?? pre.innerText
    try {
      const { svg } = await mermaid.render(`diagram-${i}`, source)
      const box = document.createElement('div')
      box.className = 'diagram'
      box.innerHTML = svg
      figure.replaceWith(box)
    } catch {
      // A diagram that does not parse stays visible as its source.
    }
  }
}
