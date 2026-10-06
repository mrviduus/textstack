import type { ComponentProps } from 'react'
import { ReaderSection } from './ReaderSection'
import { ReaderNav } from './ReaderNav'
import { ReaderChapterDiscuss } from './ReaderChapterDiscuss'
import type { NormalizedChapter } from '../../hooks/useReaderChapter'
import type { ReaderSettings } from '../../hooks/useReaderSettings'

interface Props {
  chapter: NormalizedChapter
  settings: ReaderSettings
  onTap: () => void
  /** End-of-chapter Discuss; null for an anonymous reader. */
  discuss: Omit<ComponentProps<typeof ReaderChapterDiscuss>, 'chapter'> | null
  /** 1-based positional index of the chapter, null when unknown. */
  chapterNumber: number | null
  totalChapters: number | null
  chapterProgress: number
  /** Go to a neighbouring chapter (the caller flushes the leaving chapter's position). */
  onGoTo: (identifier: string) => void
  onFinish: () => void
  finishLabel: string
}

/** The reflow reader's one mounted chapter: its text, the Discuss row and the chapter nav. */
export function ReaderReflowChapter({
  chapter, settings, onTap, discuss, chapterNumber, totalChapters, chapterProgress, onGoTo, onFinish, finishLabel,
}: Props) {
  return (
    <>
      <ReaderSection
        chapterId={chapter.id}
        chapterSlug={chapter.identifier}
        chapterIndex={chapter.chapterNumber}
        html={chapter.html}
        settings={settings}
        onTap={onTap}
      />
      {/* End-of-chapter Discuss (chapter-review.md §12). Signed-in only, like the chapter-row
          action: the launcher fetches grants on mount, a 401 for every anonymous reader. */}
      {discuss && <ReaderChapterDiscuss chapter={chapter} {...discuss} />}
      <ReaderNav
        chapterTitle={chapter.title}
        chapterNumber={chapterNumber}
        totalChapters={totalChapters}
        chapterProgress={chapterProgress}
        onPrev={chapter.prev ? () => onGoTo(chapter.prev!.identifier) : null}
        onNext={chapter.next ? () => onGoTo(chapter.next!.identifier) : null}
        // The only way to the "finished" screen since the reader stopped paging.
        onFinish={onFinish}
        finishLabel={finishLabel}
      />
    </>
  )
}
