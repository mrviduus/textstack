import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../../../hooks/useCollections', () => ({ useCollections: () => ({ collections: [] }) }))

import { BulkActionBar } from '../BulkActionBar'

const props = { count: 2, onCancel: () => {}, onSelectAll: () => {}, onMarkFinished: () => {}, onDelete: () => {}, busy: false }

describe('BulkActionBar', () => {
  it('offers tag and collection menus when given them', () => {
    render(<BulkActionBar {...props} onAddTag={() => {}} onAddToCollection={() => {}} />)
    expect(screen.getByText(/library.bulk.addTag/)).toBeInTheDocument()
    expect(screen.getByText(/library.bulk.addToCollection/)).toBeInTheDocument()
  })

  it('has no tag or collection menu without them (a V2 library), and keeps finish and delete', () => {
    render(<BulkActionBar {...props} />)
    expect(screen.queryByText(/library.bulk.addTag/)).not.toBeInTheDocument()
    expect(screen.queryByText(/library.bulk.addToCollection/)).not.toBeInTheDocument()
    expect(screen.getByText('library.bulk.markFinished')).toBeInTheDocument()
    expect(screen.getByText('library.bulk.delete')).toBeInTheDocument()
  })
})
