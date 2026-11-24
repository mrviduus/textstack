import { UPLOAD_EXTENSIONS } from '@textstack/shared'

export const ACCEPT_ATTR = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(',')

function getExt(name: string): string {
  const n = name.toLowerCase()
  const idx = n.lastIndexOf('.')
  return idx === -1 ? '' : n.slice(idx + 1)
}

/** By extension only: the upload's format comes from the name (`formatOfName`), so a name without one would go up as EPUB. */
export function isUploadableFile(file: File | { name: string }): boolean {
  return UPLOAD_EXTENSIONS.includes(getExt(file.name))
}

export function partitionFiles(files: ArrayLike<File>): { valid: File[]; invalid: File[] } {
  const valid: File[] = []
  const invalid: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (isUploadableFile(f)) valid.push(f)
    else invalid.push(f)
  }
  return { valid, invalid }
}
