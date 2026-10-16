import { TextStyle } from 'react-native'

export const fonts = {
  serif: 'TextStack-Regular',
  serifBold: 'TextStack-Bold',
  serifItalic: 'TextStack-Italic',
  serifBoldItalic: 'TextStack-BoldItalic',
  sans: 'SourceSans3-Regular',
  sansMedium: 'SourceSans3-Medium',
  sansBold: 'SourceSans3-Semibold',
}

export const typography: Record<string, TextStyle> = {
  heroTitle: {
    fontFamily: fonts.serif,
    fontSize: 36,
    lineHeight: 42,
  },
  heroSubtitle: {
    fontFamily: fonts.serifItalic,
    fontSize: 16,
    lineHeight: 22,
  },
  h1: {
    fontFamily: fonts.serifBold,
    fontSize: 28,
    lineHeight: 34,
  },
  h2: {
    fontFamily: fonts.serifBold,
    fontSize: 22,
    lineHeight: 28,
  },
  h3: {
    fontFamily: fonts.sansBold,
    fontSize: 17,
    lineHeight: 22,
  },
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  bodyMedium: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    lineHeight: 22,
  },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  captionMedium: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  small: {
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
  },
  button: {
    fontFamily: fonts.sansMedium,
    fontSize: 15,
    lineHeight: 20,
  },
  tabLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    lineHeight: 14,
  },
}
