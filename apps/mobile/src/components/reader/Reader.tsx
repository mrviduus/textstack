import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import { ReaderShell } from './ReaderShell'
import type { ReaderRuntime } from './readerSource'

/**
 * The single reader entry point. Takes a fully-normalized `ReaderRuntime`
 * (built by `useEditionReaderSource` or `useUserBookReaderSource`) and renders
 * loading / error / the shared `<ReaderShell>`. Both route files are thin
 * wrappers that build the right runtime and render this — so catalog and
 * user-book books share ONE code path and can no longer drift.
 */
export function Reader({ runtime }: { runtime: ReaderRuntime }) {
  const { colors } = useTheme()
  const router = useRouter()

  if (runtime.loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    )
  }

  if (!runtime.chapter) {
    const isNotFound = runtime.chapterError === 'notfound'
    return (
      <>
        <Stack.Screen options={{ title: '', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerShadowVisible: false }} />
        <View style={[styles.center, styles.errorWrap, { backgroundColor: colors.background }]}>
          <Ionicons
            name={isNotFound ? 'help-circle-outline' : 'cloud-offline-outline'}
            size={56}
            color={colors.textSecondary}
          />
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            {isNotFound ? "We couldn't find this chapter" : "This chapter isn't available offline"}
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            {isNotFound
              ? 'The chapter may have been removed or the link is outdated.'
              : 'Download the book for offline reading, or connect to the internet and try again.'}
          </Text>
          <TouchableOpacity
            style={{ marginTop: 16, paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.primary, borderRadius: 10 }}
            onPress={() => router.back()}
            accessibilityLabel="Go back"
            accessibilityRole="button"
            activeOpacity={0.85}
          >
            <Text style={{ color: '#fff', fontFamily: fonts.sansMedium, fontSize: 15 }}>Go back</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  return (
    <ReaderShell
      source={runtime.source}
      webViewRef={runtime.webViewRef}
      injectJs={runtime.injectJs}
      chapter={runtime.chapter}
      chapterSlug={runtime.chapterSlug}
      htmlChapterSlug={runtime.htmlChapterSlug}
      bookTitle={runtime.bookTitle}
      chapters={runtime.chapters}
      chaptersLoading={runtime.chaptersLoading}
      progressRef={runtime.progressRef}
      scrollOffsetRef={runtime.scrollOffsetRef}
      currentChapterSlugRef={runtime.currentChapterSlugRef}
      bookProgressRef={runtime.bookProgressRef}
      positionRef={runtime.positionRef}
      totalWordCountRef={runtime.totalWordCountRef}
      bumpProgress={runtime.bumpProgress}
      saveProgress={runtime.saveProgress}
      onWebViewLoaded={runtime.onWebViewLoaded}
      onRestoreLanded={runtime.onRestoreLanded}
      onDocumentRebuild={runtime.onDocumentRebuild}
      beginReflow={runtime.beginReflow}
      onChapterLoaded={runtime.onChapterLoaded}
      onRequestNextChapter={runtime.onRequestNextChapter}
      onNavigateChapter={runtime.onNavigateChapter}
      bookmarks={runtime.bookmarks}
      onToggleCurrentBookmark={runtime.onToggleCurrentBookmark}
      onDeleteBookmark={runtime.onDeleteBookmark}
      bookmarkChapterSlug={runtime.bookmarkChapterSlug}
      bookTitleRef={runtime.bookTitleRef}
      wordCount={runtime.wordCount}
      explainBookId={runtime.explainBookId}
      original={runtime.original}
      originalFileUrl={runtime.originalFileUrl}
      originalInitialPage={runtime.originalInitialPage}
      originalResumePage={runtime.originalResumePage}
      originalResumeReady={runtime.originalResumeReady}
      persistPdfPage={runtime.persistPdfPage}
      onTogglePageBookmark={runtime.onTogglePageBookmark}
      isPageBookmarked={runtime.isPageBookmarked}
      onForceReflow={runtime.onForceReflow}
    />
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorWrap: { paddingHorizontal: 32, gap: 6 },
  errorTitle: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 16, textAlign: 'center' },
  errorBody: { fontFamily: fonts.sans, fontSize: 14, textAlign: 'center', marginTop: 4, maxWidth: 320 },
})
