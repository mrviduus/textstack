import { Redirect } from 'expo-router'
import { View } from 'react-native'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'

/**
 * The front door: a redirect to the reader's library (a guest too: a guest is a real session, ADR-014).
 * `/` must keep resolving: the resume-from-background reset (`app/_layout.tsx`) and the deep-link fallback
 * (`app/+not-found.tsx`) navigate to it.
 */
export default function IndexRedirect() {
  const { isLoading } = useAuth()
  const { colors } = useTheme()

  // Before the stored session is restored: an empty frame, not a redirect.
  if (isLoading) return <View style={{ flex: 1, backgroundColor: colors.background }} />
  return <Redirect href="/(tabs)/library" />
}
