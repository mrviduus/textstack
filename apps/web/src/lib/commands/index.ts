export interface PaletteRoute {
  id: string
  labelKey: string
  path: string
  icon?: string
}

export const PALETTE_ROUTES: PaletteRoute[] = [
  { id: 'page.home', labelKey: 'palette.pages.home', path: '/', icon: 'home' },
  { id: 'page.library', labelKey: 'palette.pages.library', path: '/library', icon: 'collections_bookmark' },
  { id: 'page.vocabulary', labelKey: 'palette.pages.vocabulary', path: '/vocabulary', icon: 'spellcheck' },
  { id: 'page.vocabularyReview', labelKey: 'palette.pages.vocabularyReview', path: '/vocabulary/review', icon: 'school' },
  { id: 'page.highlights', labelKey: 'palette.pages.highlights', path: '/highlights', icon: 'bookmark' },
  { id: 'page.about', labelKey: 'palette.pages.about', path: '/about', icon: 'info' },
]

export interface PaletteAction {
  id: string
  labelKey: string
  icon?: string
  // Resolved at render time — handler accesses live context
  shortcut?: string
}

export const PALETTE_ACTIONS_AUTHENTICATED: PaletteAction[] = [
  { id: 'action.upload', labelKey: 'palette.actions.upload', icon: 'upload_file' },
  { id: 'action.toggleTheme', labelKey: 'palette.actions.toggleTheme', icon: 'dark_mode' },
  { id: 'action.signOut', labelKey: 'palette.actions.signOut', icon: 'logout' },
]

export const PALETTE_ACTIONS_GUEST: PaletteAction[] = [
  { id: 'action.toggleTheme', labelKey: 'palette.actions.toggleTheme', icon: 'dark_mode' },
  { id: 'action.signIn', labelKey: 'palette.actions.signIn', icon: 'login' },
]

const RECENT_KEY = 'textstack.palette.recent'
const RECENT_MAX = 5

export interface RecentRoute {
  path: string
  ts: number
}

export function readRecentRoutes(): RecentRoute[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RecentRoute[]
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function pushRecentRoute(path: string) {
  if (!path || path === '/') return
  try {
    const existing = readRecentRoutes().filter((r) => r.path !== path)
    const next = [{ path, ts: Date.now() }, ...existing].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable — silently skip
  }
}
