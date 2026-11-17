import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { BulkActionBar } from '../BulkActionBar'

describe('BulkActionBar', () => {
  it('marks the selected books finished, or deletes them', () => {
    const onMarkFinished = vi.fn()
    const onDelete = vi.fn()
    render(<BulkActionBar count={2} onCancel={() => {}} onSelectAll={() => {}} onMarkFinished={onMarkFinished} onDelete={onDelete} />)
    fireEvent.click(screen.getByText('library.bulk.markFinished'))
    fireEvent.click(screen.getByText('library.bulk.delete'))
    expect(onMarkFinished).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
