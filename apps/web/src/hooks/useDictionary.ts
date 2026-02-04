import { useState, useCallback, useRef } from 'react'
import { lookupWord, type DictionaryEntry } from '../api/dictionary'
import {
  getCachedDictionaryEntry,
  cacheDictionaryEntry,
  type DictionaryDefinition,
} from '../lib/offlineDb'

interface DictionaryState {
  entry: DictionaryEntry | null
  isLoading: boolean
  error: string | null
}

export function useDictionary() {
  const [state, setState] = useState<DictionaryState>({
    entry: null,
    isLoading: false,
    error: null,
  })

  const abortControllerRef = useRef<AbortController | null>(null)

  const lookup = useCallback(async (word: string, lang: string) => {
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const trimmedWord = word.trim().toLowerCase()
    if (!trimmedWord) {
      setState({ entry: null, isLoading: false, error: 'No word provided' })
      return null
    }

    setState({ entry: null, isLoading: true, error: null })

    // Check cache first
    try {
      const cached = await getCachedDictionaryEntry(lang, trimmedWord)
      if (cached) {
        const entry: DictionaryEntry = {
          word: cached.word,
          phonetic: cached.phonetic,
          definitions: cached.definitions.map((d) => ({
            partOfSpeech: d.partOfSpeech,
            definitions: d.definitions,
          })),
        }
        setState({ entry, isLoading: false, error: null })
        return entry
      }
    } catch {
      // Cache read failed, continue with API call
    }

    // Check if offline
    if (!navigator.onLine) {
      setState({
        entry: null,
        isLoading: false,
        error: 'Dictionary unavailable offline',
      })
      return null
    }

    try {
      const entry = await lookupWord(lang, trimmedWord)

      // Cache the result
      try {
        const definitions: DictionaryDefinition[] = entry.definitions.map((d) => ({
          partOfSpeech: d.partOfSpeech,
          definitions: d.definitions.map((def) => ({
            definition: def.definition,
            example: def.example,
          })),
        }))
        await cacheDictionaryEntry(lang, trimmedWord, entry.phonetic, definitions)
      } catch {
        // Cache write failed, continue
      }

      setState({ entry, isLoading: false, error: null })
      return entry
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Dictionary lookup failed'
      setState({ entry: null, isLoading: false, error })
      return null
    }
  }, [])

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    setState({ entry: null, isLoading: false, error: null })
  }, [])

  return {
    ...state,
    lookup,
    reset,
  }
}
