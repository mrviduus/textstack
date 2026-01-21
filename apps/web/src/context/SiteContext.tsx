import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

export interface SiteConfig {
  siteId: string
  siteCode: string
  primaryDomain: string
  defaultLanguage: string
  theme: string
  adsEnabled: boolean
  indexingEnabled: boolean
  sitemapEnabled: boolean
  features: Record<string, boolean>
}

interface SiteContextValue {
  site: SiteConfig | null
  loading: boolean
  error: string | null
}

const SiteContext = createContext<SiteContextValue>({
  site: null,
  loading: true,
  error: null,
})

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export function SiteProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    fetch(`${API_BASE}/api/site/context`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error('Site not found')
        return res.json()
      })
      .then(data => {
        setSite(data)
        setLoading(false)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError(err.message)
        setLoading(false)
      })

    return () => controller.abort()
  }, [])

  return (
    <SiteContext.Provider value={{ site, loading, error }}>
      {children}
    </SiteContext.Provider>
  )
}

export function useSite() {
  return useContext(SiteContext)
}
