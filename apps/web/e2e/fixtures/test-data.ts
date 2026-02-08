import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface BookTestData {
  editionId: string
  slug: string
  title: string
  chapterCount: number
  firstChapterSlug: string
  secondChapterSlug: string
}

export interface TestData {
  enBook: BookTestData
  ukBook: BookTestData
  siteId: string
}

let cached: TestData | null = null

export function getTestData(): TestData {
  if (cached) return cached
  const dataPath = path.resolve(__dirname, '../.test-data.json')
  cached = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
  return cached!
}
