import type { Page } from '@playwright/test'

export async function waitForReaderLoad(page: Page) {
  // Wait for reader page to render (not error/loading state)
  await page.waitForSelector('#reader-content.reader-main, .reader-page', { timeout: 15_000 })
  // Ensure no error state
  const error = page.locator('.reader-error')
  if (await error.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('Reader showed error state: ' + await error.textContent())
  }
}

export async function getProgressFromLocalStorage(page: Page, editionId: string) {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`reading.progress.${id}`)
    return raw ? JSON.parse(raw) : null
  }, editionId)
}

export async function getBookmarksFromIndexedDB(page: Page) {
  return page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('textstack-reader')
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('bookmarks')) {
          resolve([])
          return
        }
        const tx = db.transaction('bookmarks', 'readonly')
        const store = tx.objectStore('bookmarks')
        const getAll = store.getAll()
        getAll.onsuccess = () => resolve(getAll.result)
        getAll.onerror = () => reject(getAll.error)
      }
    })
  })
}

export async function navigateToChapter(page: Page, chapterIndex: number) {
  // Open TOC and click chapter
  const tocButton = page.locator('[data-testid="toc-button"], [aria-label="Table of contents"], button:has-text("Contents")')
  await tocButton.click()
  const chapters = page.locator('[data-testid="toc-item"], .toc-item, .toc-entry')
  await chapters.nth(chapterIndex).click()
}

export async function goToNextPage(page: Page) {
  const nextBtn = page.locator('[data-testid="next-page-btn"], [aria-label="Next page"], button:has-text("→")')
  if (await nextBtn.isVisible()) {
    await nextBtn.click()
  }
}
