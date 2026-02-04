const API_BASE = import.meta.env.VITE_API_URL ?? ''

export interface DictionaryDefinition {
  definition: string
  example?: string
}

export interface DictionaryMeaning {
  partOfSpeech: string
  definitions: DictionaryDefinition[]
}

export interface DictionaryEntry {
  word: string
  phonetic?: string
  definitions: DictionaryMeaning[]
}

export interface DictionaryError {
  message: string
}

export async function lookupWord(
  lang: string,
  word: string
): Promise<DictionaryEntry> {
  const response = await fetch(
    `${API_BASE}/api/dictionary/${encodeURIComponent(lang)}/${encodeURIComponent(word)}`
  )

  if (response.status === 404) {
    const error = await response.json() as DictionaryError
    throw new Error(error.message || `No definition found for '${word}'`)
  }

  if (!response.ok) {
    throw new Error('Dictionary service unavailable')
  }

  return response.json()
}
