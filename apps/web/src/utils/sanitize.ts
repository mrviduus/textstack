import DOMPurify from 'dompurify'

// Rewrite book asset img src to use /api/ prefix so they route through
// the API proxy and bypass stale browser-cached 301 redirects
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src')
    if (src?.startsWith('/books/') && src.includes('/assets/')) {
      node.setAttribute('src', '/api' + src)
    }
  }
})

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html)
}
