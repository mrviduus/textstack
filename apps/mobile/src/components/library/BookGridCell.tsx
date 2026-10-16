import { View, Text, TouchableOpacity } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { getStorageUrl, type ContinueReadingPick } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import type { BookRowModel } from '../../lib/bookRow'
import { BookStatusBadge } from './BookStatusBadge'
import { GeneratedCover } from './GeneratedCover'
import { ResumeButton } from './ResumeButton'
import { styles } from './shared'

interface Props {
  model: BookRowModel
  cardWidth: number
  pick: ContinueReadingPick | undefined
  isTop: boolean
  busyKey: string | null
  onOpen: () => void
  onMenu: () => void
  onResume: (pick: ContinueReadingPick) => void
}

/** A book as a cover in the grid. Everything it shows was decided in `bookRowModel`. */
export function BookGridCell({ model, cardWidth, pick, isTop, busyKey, onOpen, onMenu, onResume }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { title, author, cover, pct, isFinished, dimmed, pill } = model

  return (
    <View style={{ width: cardWidth, marginBottom: 14, position: 'relative' }}>
      <TouchableOpacity onPress={() => onOpen()} onLongPress={() => onMenu()} activeOpacity={0.85}>
        <View>
          {cover ? (
            <Image source={getStorageUrl(cover)} style={styles.gridCover} contentFit="cover" />
          ) : (
            <GeneratedCover title={title} author={author} style={styles.gridCover} />
          )}
          {isFinished && (
            <View style={[styles.gridBadge, { backgroundColor: colors.success }]}>
              <Ionicons name="checkmark" size={10} color="#fff" />
            </View>
          )}
          {pill && (
            <View style={styles.gridPillSlot}>
              <BookStatusBadge variant={pill} />
            </View>
          )}
          {pick && (
            <View style={{ position: 'absolute', right: 6, bottom: 6 }}>
              <ResumeButton pick={pick} filled={isTop} compact onResume={onResume} busyKey={busyKey} />
            </View>
          )}
        </View>
        {pct > 0 && pct < 100 && (
          <View style={[styles.gridProgressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.gridProgressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
          </View>
        )}
        <Text style={[styles.gridTitle, { color: dimmed ? colors.textSecondary : colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        {!!author && (
          <Text style={[styles.bookAuthor, { color: colors.textSecondary }]} numberOfLines={1}>{author}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.gridDotsBtn, { backgroundColor: 'rgba(0,0,0,0.45)' }]}
        onPress={() => onMenu()}
        hitSlop={8}
        accessibilityLabel={t('library.actions.menu')}
      >
        <Ionicons name="ellipsis-vertical" size={14} color="#fff" />
      </TouchableOpacity>
    </View>
  )
}
