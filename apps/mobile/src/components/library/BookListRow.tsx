import { View, Text, TouchableOpacity } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { getStorageUrl, formatTimeAgo, type ContinueReadingPick } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import type { BookRowModel } from '../../lib/bookRow'
import type { OfflineFor } from '../../hooks/useBookOffline'
import { BookStatusBadge } from './BookStatusBadge'
import { GeneratedCover } from './GeneratedCover'
import { OfflineStateBadge } from './OfflineStateBadge'
import { ResumeButton } from './ResumeButton'
import { styles } from './shared'

interface Props {
  model: BookRowModel
  offline: ReturnType<OfflineFor>
  pick: ContinueReadingPick | undefined
  isTop: boolean
  busyKey: string | null
  onOpen: () => void
  onMenu: () => void
  onResume: (pick: ContinueReadingPick) => void
}

/** A book as a row in the shelf. Everything it shows was decided in `bookRowModel`. */
export function BookListRow({ model, offline, pick, isTop, busyKey, onOpen, onMenu, onResume }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { title, author, cover, pct, isFailed, isFinished, dimmed, pill, lastRead, errorMessage } = model
  const continuePill = pick ? <ResumeButton pick={pick} filled={isTop} onResume={onResume} busyKey={busyKey} /> : null

  return (
    <View style={[styles.bookRow, { borderBottomColor: colors.border }]}>
      <TouchableOpacity
        style={{ flexDirection: 'row', flex: 1 }}
        onPress={() => onOpen()}
        onLongPress={() => onMenu()}
        activeOpacity={0.85}
      >
        <View style={styles.coverWrapper}>
          {cover ? (
            <Image source={getStorageUrl(cover)} style={styles.cover} contentFit="cover" />
          ) : (
            <GeneratedCover title={title} author={author} style={styles.cover} />
          )}
          {pill && (
            <View style={styles.listPillSlot}>
              <BookStatusBadge variant={pill} />
            </View>
          )}
        </View>

        <View style={styles.bookInfo}>
          <Text style={[styles.bookTitle, { color: dimmed ? colors.textSecondary : colors.text }]} numberOfLines={2}>
            {title}
          </Text>
          {!!author && (
            <Text style={[styles.bookAuthor, { color: colors.textSecondary }]} numberOfLines={1}>{author}</Text>
          )}

          {isFinished ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
              <Text style={{ fontSize: 12, color: colors.success, fontFamily: fonts.sansMedium }}>
                {t('library.filter.finished')}
              </Text>
            </View>
          ) : pct > 0 ? (
            <View style={styles.progressRow}>
              <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
              </View>
              <Text style={[styles.progressText, { color: colors.textSecondary }]}>{pct}%</Text>
            </View>
          ) : null}

          {isFailed && errorMessage && (
            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.error, marginTop: 4 }} numberOfLines={2}>
              {errorMessage}
            </Text>
          )}

          {((lastRead && !isFailed) || continuePill) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: lastRead && !isFailed ? 'space-between' : 'flex-end', marginTop: 4 }}>
              {lastRead && !isFailed && (
                <Text numberOfLines={1} style={{ flexShrink: 1, marginRight: 8, fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary }}>
                  {`${t('library.lastRead')} ${formatTimeAgo(lastRead)}`}
                </Text>
              )}
              {continuePill}
            </View>
          )}

          {/* Where the book is, and the tap that changes it — on the shelf,
              not three taps inside the book. The original objection to the
              old design was exactly that you had to go in to find this.
              Both halves of the shelf: a reader should not be able to tell
              which one they are looking at. */}
          {!isFailed && (
            <OfflineStateBadge
              state={offline.state}
              percent={offline.percent}
              onDownload={offline.onDownload}
            />
          )}
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.rowDotsBtn}
        onPress={() => onMenu()}
        hitSlop={10}
        accessibilityLabel={t('library.actions.menu')}
      >
        <Ionicons name="ellipsis-vertical" size={18} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  )
}
