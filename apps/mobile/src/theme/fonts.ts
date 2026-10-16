import { useFonts } from 'expo-font'
import { Ionicons } from '@expo/vector-icons'

export function useAppFonts() {
  return useFonts({
    ...Ionicons.font,
    'TextStack-Regular': require('../../assets/fonts/TextStack-Regular.ttf'),
    'TextStack-Bold': require('../../assets/fonts/TextStack-Bold.ttf'),
    'TextStack-Italic': require('../../assets/fonts/TextStack-Italic.ttf'),
    'TextStack-BoldItalic': require('../../assets/fonts/TextStack-BoldItalic.ttf'),
    'SourceSans3-Regular': require('../../assets/fonts/SourceSans3-Regular.ttf'),
    'SourceSans3-Medium': require('../../assets/fonts/SourceSans3-Medium.ttf'),
    'SourceSans3-Semibold': require('../../assets/fonts/SourceSans3-Semibold.ttf'),
  })
}
