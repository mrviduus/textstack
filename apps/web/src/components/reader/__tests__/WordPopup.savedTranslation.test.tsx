import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WordPopup } from '../WordPopup'

vi.mock('../../vocabulary/SpeakButton', () => ({ SpeakButton: () => null }))

afterEach(cleanup)

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${Object.values(params).join(' ')}` : key

function renderPopup(savedTranslation: string | null, onUseTranslation = vi.fn()) {
  render(
    <WordPopup
      word="pocketed" translation="embolsou" translationLoading={false}
      definition={null} definitionLoading={false}
      rect={new DOMRect(0, 0, 10, 10)} containerRef={{ current: document.body }}
      onSpeak={() => {}} onClose={() => {}} isSaved
      nativeLanguage="pt" onChangeNativeLanguage={() => {}} hasConfirmedLanguage bookLanguage="en"
      t={t} savedTranslation={savedTranslation} onUseTranslation={onUseTranslation}
    />,
  )
  return onUseTranslation
}

describe('WordPopup saved translation', () => {
  it('TR-3: saved translation differs → shows "Saved as" and the button; tap uses this translation', () => {
    const onUse = renderPopup('enterrado')

    expect(screen.getByText('reader.wordPopup.savedAs enterrado')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'reader.wordPopup.useThisTranslation' }))

    expect(onUse).toHaveBeenCalledTimes(1)
  })

  it('TR-3: no differing saved translation → no button', () => {
    renderPopup(null)

    expect(screen.queryByRole('button', { name: 'reader.wordPopup.useThisTranslation' })).toBeNull()
  })
})
