import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

vi.mock('../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k, tArray: () => [], language: 'en' }),
}))

vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
import { PdfHighlightPopup } from './PdfHighlightPopup'
import type { StoredHighlight } from '../../lib/offlineDb'

const rect = { top: 100, left: 100, width: 40, height: 16, bottom: 116, right: 140 } as DOMRect

function highlight(overrides: Partial<StoredHighlight> = {}): StoredHighlight {
  return {
    id: 'h1',
    editionId: '',
    chapterId: '',
    userBookId: 'bk-1',
    anchor: { v: 1, kind: 'pdf', page: 1, rects: [], exact: 'hello' },
    color: 'yellow',
    selectedText: 'hello',
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function renderPopup(props: Partial<React.ComponentProps<typeof PdfHighlightPopup>> = {}) {
  const containerRef = { current: document.createElement('div') }
  return render(
    <PdfHighlightPopup
      highlight={highlight()}
      rect={rect}
      containerRef={containerRef}
      onRecolor={vi.fn()}
      onNoteSave={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )
}

describe('PdfHighlightPopup', () => {
  it('renders four color swatches with the active one marked', () => {
    const { container } = renderPopup()
    expect(container.querySelectorAll('.pdf-hl-popup__swatch')).toHaveLength(4)
    expect(container.querySelectorAll('.pdf-hl-popup__swatch--active')).toHaveLength(1)
  })

  it('fires onRecolor when a swatch is clicked', () => {
    const onRecolor = vi.fn()
    const { getByLabelText } = renderPopup({ onRecolor })
    fireEvent.click(getByLabelText('green'))
    expect(onRecolor).toHaveBeenCalledWith('green')
  })

  it('fires onDelete from the trash button', () => {
    const onDelete = vi.fn()
    const { getByLabelText } = renderPopup({ onDelete })
    fireEvent.click(getByLabelText('reader.noteEditor.deleteHighlight'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('saves the edited note text', () => {
    const onNoteSave = vi.fn()
    const { container, getByText } = renderPopup({ onNoteSave })
    const textarea = container.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: '  my note  ' } })
    fireEvent.click(getByText('reader.noteEditor.save'))
    expect(onNoteSave).toHaveBeenCalledWith('my note')
  })

  it('renders nothing when rect is null', () => {
    const { container } = renderPopup({ rect: null })
    expect(container.querySelector('.pdf-hl-popup')).toBeNull()
  })

  it('does not save the note when it is unchanged (L5 — recolor + dismiss)', () => {
    // Highlight already has a note; the user only recolors, then click-outside
    // dismisses. The note is identical → no redundant onNoteSave PUT.
    const onNoteSave = vi.fn()
    renderPopup({ onNoteSave, highlight: highlight({ noteText: 'kept note' }) })
    fireEvent.mouseDown(document.body)
    expect(onNoteSave).not.toHaveBeenCalled()
  })

  it('does not save when a note-less highlight is dismissed untouched (L5)', () => {
    const onNoteSave = vi.fn()
    renderPopup({ onNoteSave })
    fireEvent.click(document.querySelector('.note-editor__save')!)
    expect(onNoteSave).not.toHaveBeenCalled()
  })

  it('still saves when the note text actually changed', () => {
    const onNoteSave = vi.fn()
    const { container, getByText } = renderPopup({
      onNoteSave,
      highlight: highlight({ noteText: 'old' }),
    })
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'new' } })
    fireEvent.click(getByText('reader.noteEditor.save'))
    expect(onNoteSave).toHaveBeenCalledWith('new')
  })
})
