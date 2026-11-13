import { ScrollView, View, Text, StyleSheet, TouchableOpacity, Linking, Platform } from 'react-native'
import { Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../src/context/ThemeContext'
import { useLanguage } from '../src/context/LanguageContext'
import { fonts } from '../src/theme/typography'

const REPO_URL = 'https://github.com/mrviduus/textstack'
const SELF_HOST_URL = 'https://mrviduus.github.io/textstack/self-host/'
const CONTACT_EMAIL = 'vasyl.vdov@gmail.com'

export default function AboutScreen() {
  const { colors } = useTheme()
  const { t } = useLanguage()

  return (
    <>
      <Stack.Screen options={{
        title: t('about.title'),
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
        headerShadowVisible: false,
      }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.text }]}>{t('about.title')}</Text>

        <Text style={[styles.intro, { color: colors.text }]}>{t('about.intro')}</Text>

        <Text style={[styles.body, { color: colors.text }]}>{t('about.body1')}</Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('about.missionHeading')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>{t('about.mission1')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>{t('about.mission2')}</Text>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('about.openSourceHeading')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>{t('about.openSource1')}</Text>

        <View style={styles.osButtons}>
          <TouchableOpacity
            style={[styles.osBtn, styles.osBtnPrimary, { backgroundColor: colors.text }]}
            onPress={() => Linking.openURL(REPO_URL)}
            accessibilityRole="link"
            accessibilityLabel={t('about.starOnGitHub')}
          >
            <Ionicons name="star-outline" size={18} color={colors.background} />
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.background }}>
              {t('about.starOnGitHub')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.osBtn, { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }]}
            onPress={() => Linking.openURL(SELF_HOST_URL)}
            accessibilityRole="link"
            accessibilityLabel={t('about.selfHostGuide')}
          >
            <Ionicons name="server-outline" size={18} color={colors.text} />
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.text }}>
              {t('about.selfHostGuide')}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('about.techHeading')}</Text>
        <Text style={[styles.body, { color: colors.text }]}>{t('about.tech1')}</Text>

        <View style={[styles.stackBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.stackLabel, { color: colors.text }]}>{t('about.techStackLabel')}:</Text>
          <Text style={[styles.stackValue, { color: colors.textSecondary }]}>{t('about.techStackValue')}</Text>
        </View>

        {/* Creator card */}
        <View style={[styles.creatorCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.creatorAvatar, { backgroundColor: colors.primary }]}>
            <Text style={{ fontFamily: fonts.serifBold, fontSize: 28, color: '#fff' }}>V</Text>
          </View>
          <Text style={[styles.creatorHeading, { color: colors.textSecondary }]}>{t('about.creator.heading')}</Text>
          <Text style={[styles.creatorName, { color: colors.text }]}>Vasyl Vdovychenko</Text>

          <Text style={[styles.creatorBio, { color: colors.text }]}>{t('about.creator.bio1')}</Text>
          <Text style={[styles.creatorBio, { color: colors.text }]}>{t('about.creator.bio2')}</Text>

          <View style={{ gap: 8, width: '100%', marginTop: 4 }}>
            <TouchableOpacity
              style={[styles.creatorBtn, { backgroundColor: colors.primary }]}
              onPress={() => Linking.openURL(`mailto:${CONTACT_EMAIL}`)}
              accessibilityRole="link"
              accessibilityLabel={t('about.creator.email')}
            >
              <Ionicons name="mail-outline" size={18} color="#fff" />
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: '#fff' }}>{t('about.creator.email')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.creatorBtn, { borderWidth: 1, borderColor: colors.border }]}
              onPress={() => Linking.openURL('https://www.linkedin.com/in/vasyl-vdovychenko/')}
              accessibilityRole="link"
              accessibilityLabel={t('about.creator.linkedin')}
            >
              <Ionicons name="logo-linkedin" size={18} color={colors.text} />
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.text }}>{t('about.creator.linkedin')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.creatorBtn, { borderWidth: 1, borderColor: colors.border }]}
              onPress={() => Linking.openURL('https://vasyl.blog/')}
              accessibilityRole="link"
              accessibilityLabel={t('about.creator.blog')}
            >
              <Ionicons name="globe-outline" size={18} color={colors.text} />
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.text }}>{t('about.creator.blog')}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontFamily: fonts.serifBold, fontSize: 28, marginBottom: 16 },
  intro: { fontFamily: fonts.sansMedium, fontSize: 17, lineHeight: 26, marginBottom: 16 },
  sectionTitle: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 24, marginBottom: 8 },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 24, marginBottom: 12 },

  osButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 8 },
  osBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  osBtnPrimary: {},

  stackBox: {
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  stackLabel: { fontFamily: fonts.sansMedium, fontSize: 13, marginBottom: 4 },
  stackValue: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
  },

  creatorCard: { marginTop: 28, padding: 20, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  creatorAvatar: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  creatorHeading: { fontFamily: fonts.sansMedium, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 },
  creatorName: { fontFamily: fonts.serifBold, fontSize: 20, marginBottom: 12 },
  creatorBio: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 22, marginBottom: 8, textAlign: 'left' },
  creatorBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, borderRadius: 8 },
})
