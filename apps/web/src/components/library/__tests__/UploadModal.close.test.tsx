import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
const form = vi.hoisted(() => ({ done: (_id?: string) => {} }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('../../../context/LanguageContext', () => ({ useLanguage: () => ({ getLocalizedPath: (p: string) => `/en${p}` }) }))
vi.mock('../../../platform', () => ({ platform: { onBackButton: () => () => {} } }))
vi.mock('../UploadForm', () => ({
  UploadForm: ({ onUploadComplete }: { onUploadComplete: (id?: string) => void }) => { form.done = onUploadComplete; return <p>form</p> },
}))

import { UploadModal } from '../UploadModal'

describe('the upload dialog and a finished upload', () => {
  beforeEach(() => navigate.mockReset())

  it('opens the new book in the reader', () => {
    render(<UploadModal open onClose={() => {}} />)
    form.done('b1')
    expect(navigate).toHaveBeenCalledWith('/en/library/my/b1/read')
  })

  it('leaves the reader where they are when the dialog was closed while the file went up', () => {
    const { rerender } = render(<UploadModal open onClose={() => {}} />)
    const done = form.done
    rerender(<UploadModal open={false} onClose={() => {}} />)
    done('b1')
    expect(navigate).not.toHaveBeenCalled()
  })
})
