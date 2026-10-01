// Native language catalogue — single source of truth for the language picker,
// web and mobile. Flag rendering stays per platform (web: Twemoji, see
// apps/web/src/data/flags.ts); mobile renders names only.

export interface LanguageEntry {
  code: string          // BCP 47 / ISO 639-1 lang code ('hi')
  englishName: string   // 'Hindi'
  nativeName: string    // 'हिन्दी'
  flagCountry: string   // ISO 3166 country code ('IN')
  popular?: boolean
}

export function getLanguage(code: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.code === code)
}

export const LANGUAGES: LanguageEntry[] = [
  // Popular — ordered as shown in picker. pt-BR promoted for Brazil audience.
  { code: 'en', englishName: 'English', nativeName: 'English', flagCountry: 'GB', popular: true },
  { code: 'pt-BR', englishName: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', flagCountry: 'BR', popular: true },
  { code: 'ru', englishName: 'Russian', nativeName: 'Русский', flagCountry: 'RU', popular: true },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', flagCountry: 'DE', popular: true },
  { code: 'fr', englishName: 'French', nativeName: 'Français', flagCountry: 'FR', popular: true },
  { code: 'es', englishName: 'Spanish', nativeName: 'Español', flagCountry: 'ES', popular: true },
  { code: 'pl', englishName: 'Polish', nativeName: 'Polski', flagCountry: 'PL', popular: true },
  { code: 'uk', englishName: 'Ukrainian', nativeName: 'Українська', flagCountry: 'UA', popular: true },
  { code: 'fa', englishName: 'Persian', nativeName: 'فارسی', flagCountry: 'IR', popular: true },

  // All other supported languages (alphabetical by English name)
  { code: 'af', englishName: 'Afrikaans', nativeName: 'Afrikaans', flagCountry: 'ZA' },
  { code: 'sq', englishName: 'Albanian', nativeName: 'Shqip', flagCountry: 'AL' },
  { code: 'am', englishName: 'Amharic', nativeName: 'አማርኛ', flagCountry: 'ET' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', flagCountry: 'SA' },
  { code: 'hy', englishName: 'Armenian', nativeName: 'Հայերեն', flagCountry: 'AM' },
  { code: 'az', englishName: 'Azerbaijani', nativeName: 'Azərbaycan', flagCountry: 'AZ' },
  { code: 'eu', englishName: 'Basque', nativeName: 'Euskara', flagCountry: 'ES' },
  { code: 'be', englishName: 'Belarusian', nativeName: 'Беларуская', flagCountry: 'BY' },
  { code: 'bn', englishName: 'Bengali', nativeName: 'বাংলা', flagCountry: 'BD' },
  { code: 'bs', englishName: 'Bosnian', nativeName: 'Bosanski', flagCountry: 'BA' },
  { code: 'bg', englishName: 'Bulgarian', nativeName: 'Български', flagCountry: 'BG' },
  { code: 'my', englishName: 'Burmese', nativeName: 'မြန်မာ', flagCountry: 'MM' },
  { code: 'ca', englishName: 'Catalan', nativeName: 'Català', flagCountry: 'ES' },
  { code: 'zh', englishName: 'Chinese', nativeName: '中文', flagCountry: 'CN' },
  { code: 'zh-TW', englishName: 'Chinese (Traditional)', nativeName: '繁體中文', flagCountry: 'TW' },
  { code: 'hr', englishName: 'Croatian', nativeName: 'Hrvatski', flagCountry: 'HR' },
  { code: 'cs', englishName: 'Czech', nativeName: 'Čeština', flagCountry: 'CZ' },
  { code: 'da', englishName: 'Danish', nativeName: 'Dansk', flagCountry: 'DK' },
  { code: 'nl', englishName: 'Dutch', nativeName: 'Nederlands', flagCountry: 'NL' },
  { code: 'eo', englishName: 'Esperanto', nativeName: 'Esperanto', flagCountry: 'EU' },
  { code: 'et', englishName: 'Estonian', nativeName: 'Eesti', flagCountry: 'EE' },
  { code: 'fo', englishName: 'Faroese', nativeName: 'Føroyskt', flagCountry: 'FO' },
  { code: 'tl', englishName: 'Filipino', nativeName: 'Filipino', flagCountry: 'PH' },
  { code: 'fi', englishName: 'Finnish', nativeName: 'Suomi', flagCountry: 'FI' },
  { code: 'gl', englishName: 'Galician', nativeName: 'Galego', flagCountry: 'ES' },
  { code: 'ka', englishName: 'Georgian', nativeName: 'ქართული', flagCountry: 'GE' },
  { code: 'el', englishName: 'Greek', nativeName: 'Ελληνικά', flagCountry: 'GR' },
  { code: 'gu', englishName: 'Gujarati', nativeName: 'ગુજરાતી', flagCountry: 'IN' },
  { code: 'ha', englishName: 'Hausa', nativeName: 'Hausa', flagCountry: 'NG' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', flagCountry: 'IL' },
  { code: 'hi', englishName: 'Hindi', nativeName: 'हिन्दी', flagCountry: 'IN' },
  { code: 'hu', englishName: 'Hungarian', nativeName: 'Magyar', flagCountry: 'HU' },
  { code: 'is', englishName: 'Icelandic', nativeName: 'Íslenska', flagCountry: 'IS' },
  { code: 'ig', englishName: 'Igbo', nativeName: 'Igbo', flagCountry: 'NG' },
  { code: 'id', englishName: 'Indonesian', nativeName: 'Bahasa Indonesia', flagCountry: 'ID' },
  { code: 'ga', englishName: 'Irish', nativeName: 'Gaeilge', flagCountry: 'IE' },
  { code: 'it', englishName: 'Italian', nativeName: 'Italiano', flagCountry: 'IT' },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語', flagCountry: 'JP' },
  { code: 'kn', englishName: 'Kannada', nativeName: 'ಕನ್ನಡ', flagCountry: 'IN' },
  { code: 'kk', englishName: 'Kazakh', nativeName: 'Қазақша', flagCountry: 'KZ' },
  { code: 'km', englishName: 'Khmer', nativeName: 'ខ្មែរ', flagCountry: 'KH' },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어', flagCountry: 'KR' },
  { code: 'ky', englishName: 'Kyrgyz', nativeName: 'Кыргызча', flagCountry: 'KG' },
  { code: 'lo', englishName: 'Lao', nativeName: 'ລາວ', flagCountry: 'LA' },
  { code: 'la', englishName: 'Latin', nativeName: 'Latina', flagCountry: 'VA' },
  { code: 'lv', englishName: 'Latvian', nativeName: 'Latviešu', flagCountry: 'LV' },
  { code: 'lt', englishName: 'Lithuanian', nativeName: 'Lietuvių', flagCountry: 'LT' },
  { code: 'lb', englishName: 'Luxembourgish', nativeName: 'Lëtzebuergesch', flagCountry: 'LU' },
  { code: 'mk', englishName: 'Macedonian', nativeName: 'Македонски', flagCountry: 'MK' },
  { code: 'ms', englishName: 'Malay', nativeName: 'Bahasa Melayu', flagCountry: 'MY' },
  { code: 'ml', englishName: 'Malayalam', nativeName: 'മലയാളം', flagCountry: 'IN' },
  { code: 'mt', englishName: 'Maltese', nativeName: 'Malti', flagCountry: 'MT' },
  { code: 'mr', englishName: 'Marathi', nativeName: 'मराठी', flagCountry: 'IN' },
  { code: 'mn', englishName: 'Mongolian', nativeName: 'Монгол', flagCountry: 'MN' },
  { code: 'ne', englishName: 'Nepali', nativeName: 'नेपाली', flagCountry: 'NP' },
  { code: 'no', englishName: 'Norwegian', nativeName: 'Norsk', flagCountry: 'NO' },
  { code: 'ps', englishName: 'Pashto', nativeName: 'پښتو', flagCountry: 'AF' },
  { code: 'pt', englishName: 'Portuguese', nativeName: 'Português', flagCountry: 'PT' },
  { code: 'pa', englishName: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', flagCountry: 'IN' },
  { code: 'ro', englishName: 'Romanian', nativeName: 'Română', flagCountry: 'RO' },
  { code: 'sr', englishName: 'Serbian', nativeName: 'Српски', flagCountry: 'RS' },
  { code: 'sd', englishName: 'Sindhi', nativeName: 'سنڌي', flagCountry: 'PK' },
  { code: 'si', englishName: 'Sinhala', nativeName: 'සිංහල', flagCountry: 'LK' },
  { code: 'sk', englishName: 'Slovak', nativeName: 'Slovenčina', flagCountry: 'SK' },
  { code: 'sl', englishName: 'Slovenian', nativeName: 'Slovenščina', flagCountry: 'SI' },
  { code: 'sw', englishName: 'Swahili', nativeName: 'Kiswahili', flagCountry: 'KE' },
  { code: 'sv', englishName: 'Swedish', nativeName: 'Svenska', flagCountry: 'SE' },
  { code: 'tg', englishName: 'Tajik', nativeName: 'Тоҷикӣ', flagCountry: 'TJ' },
  { code: 'ta', englishName: 'Tamil', nativeName: 'தமிழ்', flagCountry: 'IN' },
  { code: 'te', englishName: 'Telugu', nativeName: 'తెలుగు', flagCountry: 'IN' },
  { code: 'th', englishName: 'Thai', nativeName: 'ไทย', flagCountry: 'TH' },
  { code: 'tr', englishName: 'Turkish', nativeName: 'Türkçe', flagCountry: 'TR' },
  { code: 'ur', englishName: 'Urdu', nativeName: 'اردو', flagCountry: 'PK' },
  { code: 'uz', englishName: 'Uzbek', nativeName: "O'zbekcha", flagCountry: 'UZ' },
  { code: 'vi', englishName: 'Vietnamese', nativeName: 'Tiếng Việt', flagCountry: 'VN' },
  { code: 'cy', englishName: 'Welsh', nativeName: 'Cymraeg', flagCountry: 'GB' },
  { code: 'xh', englishName: 'Xhosa', nativeName: 'isiXhosa', flagCountry: 'ZA' },
  { code: 'yo', englishName: 'Yoruba', nativeName: 'Yorùbá', flagCountry: 'NG' },
  { code: 'zu', englishName: 'Zulu', nativeName: 'isiZulu', flagCountry: 'ZA' },
]

export const POPULAR_LANGUAGES = LANGUAGES.filter((l) => l.popular)
export const OTHER_LANGUAGES = LANGUAGES.filter((l) => !l.popular)
