const API_BASE = import.meta.env.VITE_API_URL ?? ''

export interface TranslateResponse {
  translatedText: string
  sourceLang: string
  targetLang: string
}

export interface LanguageInfo {
  code: string
  name: string
}

export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<TranslateResponse> {
  const res = await fetch(`${API_BASE}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      sourceLang,
      targetLang,
    }),
  })

  if (!res.ok) {
    if (res.status === 503) {
      throw new Error('Translation service unavailable')
    }
    if (res.status === 504) {
      throw new Error('Translation request timed out')
    }
    const text = await res.text()
    let error = `Translation failed: ${res.status}`
    try {
      const json = JSON.parse(text)
      if (json.detail) error = json.detail
    } catch {}
    throw new Error(error)
  }

  return res.json()
}

export async function getLanguages(): Promise<LanguageInfo[]> {
  const res = await fetch(`${API_BASE}/api/translate/languages`)

  if (!res.ok) {
    throw new Error('Failed to fetch languages')
  }

  return res.json()
}
