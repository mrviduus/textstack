import en from '@/translations/en.json';
import uk from '@/translations/uk.json';

export const resources = {
  en: {
    translation: en,
  },
  uk: {
    translation: uk,
  },
};

export type Language = keyof typeof resources;
