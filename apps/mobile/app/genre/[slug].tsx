import { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { createBooksApi, getStorageUrl } from '@textstack/shared'
import type { GenreDetail } from '@textstack/shared'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { fonts } from '../../src/theme/typography'
import { BookCard } from '../../src/components/ui/BookCard'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'

export default function GenreScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const router = useRouter()
  const { colors } = useTheme()
  const { language } = useLanguage()
  const [genre, setGenre] = useState<GenreDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const api = createBooksApi(language)
    api.getGenre(slug)
      .then(g => { if (!cancelled) { setGenre(g); setError(null) } })
      .catch(e => {
        if (cancelled) return
        console.warn('Failed to load genre:', e)
        const status = (e as { status?: number })?.status
        setError(status === 404 ? 'notfound' : 'network')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [slug, language, retryNonce])

  const retry = useCallback(() => setRetryNonce(n => n + 1), [])

  if (!loading && error) {
    const isNotFound = error === 'notfound'
    return (
      <>
        <Stack.Screen options={{ title: '', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerShadowVisible: false }} />
        <View style={[styles.container, styles.errorBox, { backgroundColor: colors.background }]}>
          <Ionicons name={isNotFound ? 'help-circle-outline' : 'cloud-offline-outline'} size={48} color={colors.textSecondary} />
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            {isNotFound ? 'Genre not found' : "Couldn't load this genre"}
          </Text>
          <Text style={[styles.errorSub, { color: colors.textSecondary }]}>
            {isNotFound
              ? 'This genre may have been removed or renamed.'
              : 'Check your connection and try again.'}
          </Text>
          <View style={styles.errorActions}>
            {!isNotFound && (
              <TouchableOpacity onPress={retry} style={[styles.errorBtn, { borderColor: colors.primary }]}>
                <Text style={{ color: colors.primary, fontFamily: fonts.sansMedium }}>Retry</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => router.back()} style={[styles.errorBtn, { borderColor: colors.border }]}>
              <Text style={{ color: colors.text, fontFamily: fonts.sansMedium }}>Go back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </>
    )
  }

  if (loading || !genre) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={{ padding: 16, gap: 8 }}>
            <SkeletonLoader width="50%" height={28} />
            <SkeletonLoader width="30%" height={16} />
            <SkeletonLoader width="100%" height={60} style={{ marginTop: 12 }} />
          </View>
        </View>
      </>
    )
  }

  return (
    <>
      <Stack.Screen options={{
        title: genre.name,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
        headerShadowVisible: false,
      }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <Text style={[styles.name, { color: colors.text }]}>{genre.name}</Text>
          <View style={styles.metaRow}>
            <Ionicons name="library-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {genre.bookCount} {genre.bookCount === 1 ? 'book' : 'books'}
            </Text>
          </View>
          {genre.description && (
            <Text style={[styles.description, { color: colors.text }]}>{genre.description}</Text>
          )}
        </View>

        {genre.editions.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Books</Text>
            <View style={styles.booksGrid}>
              {genre.editions.map(ed => (
                <BookCard
                  key={ed.id}
                  title={ed.title}
                  // `?? []` is not defensive noise: an OTA and an API deploy are separate events, so
                  // this bundle can run against a server that predates authors being sent here. It
                  // threw `Cannot read property 'map' of undefined` on every genre with books until
                  // 2026-09-11, because the shared type promised a field the endpoint never sent.
                  author={(ed.authors ?? []).map(a => a.name).join(', ')}
                  coverUrl={getStorageUrl(ed.coverPath)}
                  onPress={() => router.push(`/book/${ed.slug}`)}
                />
              ))}
            </View>
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 },
  name: { fontFamily: fonts.serifBold, fontSize: 28 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  metaText: { fontFamily: fonts.sans, fontSize: 13 },
  description: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 22, marginTop: 12 },
  sectionTitle: { fontFamily: fonts.serifBold, fontSize: 20, paddingHorizontal: 16, marginBottom: 12 },
  booksGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, justifyContent: 'space-between' },
  errorBox: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 80, gap: 10 },
  errorTitle: { fontFamily: fonts.serifBold, fontSize: 20, textAlign: 'center', marginTop: 12 },
  errorSub: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  errorActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  errorBtn: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1 },
})
