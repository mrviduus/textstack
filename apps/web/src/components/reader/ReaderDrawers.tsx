import type { ComponentProps } from 'react'
import { ReaderTocDrawer } from './ReaderTocDrawer'
import { ReaderSettingsDrawer } from './ReaderSettingsDrawer'
import { ReaderSearchDrawer } from './ReaderSearchDrawer'
import type { useReaderDrawers } from '../../hooks/useReaderDrawers'

interface Props {
  drawers: ReturnType<typeof useReaderDrawers>
  toc: Omit<ComponentProps<typeof ReaderTocDrawer>, 'open' | 'onClose'>
  settings: ComponentProps<typeof ReaderSettingsDrawer>['settings']
  onSettingsUpdate: ComponentProps<typeof ReaderSettingsDrawer>['onUpdate']
  /** Original-layout PDF: the settings drawer hides typography. */
  originalMode: boolean
}

/** The reader's TOC, settings and in-chapter search drawers; open state lives in useReaderDrawers. */
export function ReaderDrawers({ drawers, toc, settings, onSettingsUpdate, originalMode }: Props) {
  const { tocOpen, setTocOpen, settingsOpen, setSettingsOpen, searchOpen, setSearchOpen, search } = drawers
  return (
    <>
      <ReaderTocDrawer
        {...toc}
        open={tocOpen}
        onClose={() => setTocOpen(false)}
      />

      <ReaderSettingsDrawer
        open={settingsOpen}
        settings={settings}
        onUpdate={onSettingsUpdate}
        onClose={() => setSettingsOpen(false)}
        originalMode={originalMode}
      />

      <ReaderSearchDrawer
        open={searchOpen}
        query={search.query}
        matches={search.matches}
        activeMatchIndex={search.activeMatchIndex}
        onSearch={search.search}
        onGoToMatch={search.goToMatch}
        onNextMatch={search.nextMatch}
        onPrevMatch={search.prevMatch}
        onClose={() => {
          setSearchOpen(false)
          search.clear()
        }}
      />
    </>
  )
}
