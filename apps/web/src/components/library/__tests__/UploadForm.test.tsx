import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const uploadUserBookMock = vi.fn()
const getStorageQuotaMock = vi.fn(() => Promise.resolve(null))

vi.mock('../../../api/userBooks', () => ({
  uploadUserBook: (...args: unknown[]) => uploadUserBookMock(...args),
  getStorageQuota: () => getStorageQuotaMock(),
}))
vi.mock('../../../lib/telemetry/myBooks', () => ({ emit: vi.fn() }))
vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { UploadForm } from '../UploadForm'

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// File stub with controllable head/tail bytes.
function makeFile(name: string, head: Uint8Array, tail: Uint8Array): File {
  return {
    name,
    type: name.endsWith('.pdf') ? 'application/pdf' : '',
    size: 1234,
    slice(start?: number) {
      const chunk = typeof start === 'number' && start < 0 ? tail : head
      return { arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) } as Blob
    },
  } as unknown as File
}

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

describe('UploadForm', () => {
  beforeEach(() => {
    uploadUserBookMock.mockReset()
    uploadUserBookMock.mockResolvedValue({ userBookId: 'b1', hasOriginalPdf: true })
  })
  afterEach(() => cleanup())

  it('truncated pdf pick → error shown, upload not called', async () => {
    render(<UploadForm onUploadComplete={vi.fn()} />)
    pickFile(makeFile('book.pdf', bytes('%PDF-1.7'), bytes('...cut off...')))
    await waitFor(() =>
      expect(screen.getByText('upload.dropzone.truncatedPdf')).toBeInTheDocument(),
    )
    expect(uploadUserBookMock).not.toHaveBeenCalled()
  })

  it('complete pdf pick → upload called', async () => {
    render(<UploadForm onUploadComplete={vi.fn()} />)
    pickFile(makeFile('book.pdf', bytes('%PDF-1.7'), bytes('startxref 9 %%EOF')))
    await waitFor(() => expect(uploadUserBookMock).toHaveBeenCalledTimes(1))
  })

  it('epub pick → upload called (check skipped)', async () => {
    render(<UploadForm onUploadComplete={vi.fn()} />)
    pickFile(makeFile('book.epub', bytes('PK\x03\x04'), bytes('junk')))
    await waitFor(() => expect(uploadUserBookMock).toHaveBeenCalledTimes(1))
  })
})
