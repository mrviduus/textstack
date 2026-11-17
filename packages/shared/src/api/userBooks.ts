/** The user-book detail the mobile app maps V2 onto (`getV2UserBook`). */
export interface UserBookDetailResponse {
  id: string
  title: string
  slug: string
  language: string
  author: string | null
  description: string | null
  coverPath: string | null
  genre: string | null
  publishedYear: number | null
  totalWordCount: number | null
  status: string
  errorMessage: string | null
  chapters: {
    id: string
    chapterNumber: number
    slug: string | null
    title: string
    wordCount: number | null
    /** 1-based PDF page where this chapter starts. Null for EPUBs / unknown. */
    sourceStartPage?: number | null
  }[]
  toc: { title: string; chapterNumber: number | null; children: any[] | null }[] | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** True when the original upload is a PDF that can be rendered in the opt-in
   *  "Original layout" view. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
  /** V2 (M5 #1031): the book's current file has its bytes in, so the V2 reader can open it. Absent on legacy. */
  hasFile?: boolean
  /** Size of the original file the device would download. The download button
   *  shows it, and the ask-before-mobile-data rule reads it. Null when the book
   *  has no stored original; absent on older payloads. */
  originalFileBytes?: number | null
  /** PDF-2: the PDF's real page count (`UserBook.PageCount`). Null/absent → estimate from words. */
  pageCount?: number | null
  /** LLM metadata enrichment lifecycle (genre/year/description generation).
   *  "NotStarted" | "Pending" | "Running" | "Completed" | "Failed".
   *  Absent on older payloads → treat as no enrichment in flight. */
  metadataEnrichmentStatus?: string
  /** Page a clipped article came from. Null for uploaded files; absent on older payloads. */
  sourceUrl?: string | null
  /** V2 (`/me/v2`): the book's current file version. Absent on legacy. */
  fileId?: string | null
}
