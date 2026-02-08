import type { Page } from '@playwright/test'

export async function clearLocalStorage(page: Page) {
  await page.evaluate(() => localStorage.clear())
}

export async function clearIndexedDB(page: Page, dbName = 'textstack-reader') {
  await page.evaluate((name) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }, dbName)
}

export async function getLocalStorageItem(page: Page, key: string) {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

export async function setLocalStorageItem(page: Page, key: string, value: string) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value])
}
