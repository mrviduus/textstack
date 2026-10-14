/**
 * What the reader engine opens a PDF from (`ChapterDoc['pdf']`): the bytes, or their length and ranges read by
 * the host (which owns auth). Its own file, with no code: the engine imports it by relative path, and its
 * boundary test forbids a module with `fetch` (pdfRangeSource builds one).
 */
export type PdfSource =
  | { data: ArrayBuffer }
  | { length: number; read(begin: number, end: number): Promise<Uint8Array> }
