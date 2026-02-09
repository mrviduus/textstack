import { test, expect } from '@playwright/test'
import { test as authTest, expect as authExpect } from '../fixtures/auth.fixture'

test.describe('Ukrainian i18n — public pages', () => {
  test('header shows Ukrainian nav on /uk/books', async ({ page }) => {
    await page.goto('/uk/books')
    await page.waitForLoadState('domcontentloaded')
    const header = page.locator('header.site-header')
    await expect(header).toContainText('Каталог')
    await expect(header).not.toContainText('Catalog')
  })

  test('footer shows Ukrainian text on /uk/books', async ({ page }) => {
    await page.goto('/uk/books')
    await page.waitForLoadState('domcontentloaded')
    const footer = page.locator('footer.site-footer')
    await expect(footer).toContainText('Політика конфіденційності')
    await expect(footer).toContainText('Умови використання')
    await expect(footer).toContainText("Зв'язатися з нами")
  })

  test('/uk/about shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/about')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Про нас')
    await expect(page.locator('h1')).not.toContainText('About')
    await expect(page.locator('.about-page__prose')).toContainText('Наша місія')
  })

  test('/uk/contact shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/contact')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText("Зв'язатися з нами")
    await expect(page.locator('h1')).not.toContainText('Contact Us')
  })

  test('/uk/books shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/books')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Книги')
    await expect(page.locator('h1')).not.toContainText('Books')
  })

  test('/uk/search shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/search')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Пошук')
    await expect(page.locator('h1')).not.toContainText('Search')
  })

  test('/uk/privacy shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/privacy')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Політика конфіденційності')
    await expect(page.locator('h1')).not.toContainText('Privacy Policy')
  })

  test('/uk/terms shows Ukrainian text', async ({ page }) => {
    await page.goto('/uk/terms')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Умови використання')
    await expect(page.locator('h1')).not.toContainText('Terms of Service')
  })
})

test.describe('English i18n — sanity check', () => {
  test('/en/about shows English text', async ({ page }) => {
    await page.goto('/en/about')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('About')
  })

  test('/en/books shows English text', async ({ page }) => {
    await page.goto('/en/books')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1')).toContainText('Books')
  })
})

authTest.describe('Ukrainian i18n — library (authed)', () => {
  authTest('/uk/library shows Ukrainian text', async ({ authedPage }) => {
    await authedPage.goto('/uk/library')
    await authedPage.waitForLoadState('domcontentloaded')
    await authExpect(authedPage.locator('h1')).toContainText('Моя бібліотека')
    await authExpect(authedPage.locator('.library-sidebar')).toContainText('Збережені')
  })
})
