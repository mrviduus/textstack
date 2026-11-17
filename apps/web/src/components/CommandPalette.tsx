import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../hooks/useTranslation'
import { useLanguage } from '../context/LanguageContext'
import { useAuth } from '../context/AuthContext'
import { useDarkMode } from '../hooks/useDarkMode'
import {
  PALETTE_ROUTES,
  PALETTE_ACTIONS_AUTHENTICATED,
  PALETTE_ACTIONS_GUEST,
  readRecentRoutes,
  type RecentRoute,
} from '../lib/commands'
import { getUserBooks, type UserBook } from '../api/userBooks'

interface Props {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: Props) {
  const { t } = useTranslation()
  const { language, getLocalizedPath } = useLanguage()
  const { isAuthenticated, logout, openAuthModal } = useAuth()
  const { toggleTheme } = useDarkMode()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [books, setBooks] = useState<UserBook[]>([])
  const [recent, setRecent] = useState<RecentRoute[]>([])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setRecent(readRecentRoutes())
    if (isAuthenticated && books.length === 0) {
      getUserBooks().then((b) => setBooks(b.slice(0, 50))).catch(() => {})
    }
  }, [open, isAuthenticated, books.length])

  const go = (path: string) => {
    navigate(getLocalizedPath(path))
    onClose()
  }

  const actions = isAuthenticated ? PALETTE_ACTIONS_AUTHENTICATED : PALETTE_ACTIONS_GUEST

  const recentRoutes = useMemo(() => {
    const knownPaths = new Set(PALETTE_ROUTES.map((r) => r.path))
    return recent.filter((r) => !knownPaths.has(r.path))
  }, [recent])

  if (!open) return null

  const handleAction = (id: string) => {
    switch (id) {
      case 'action.upload':
        onClose()
        window.dispatchEvent(new Event('textstack:open-upload'))
        break
      case 'action.toggleTheme':
        toggleTheme()
        onClose()
        break
      case 'action.signOut':
        onClose()
        logout()
        break
      case 'action.signIn':
        onClose()
        openAuthModal()
        break
    }
  }

  const readerPathFor = (book: UserBook) => {
    const slug = book.progressChapterSlug
    return slug
      ? `/library/my/${book.id}/read/${slug}`
      : `/library/my/${book.id}`
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose() }}
      label={t('palette.title')}
      className="cmd-palette"
    >
      <Command.Input
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={t('palette.placeholder')}
        className="cmd-palette__input"
      />
      <Command.List className="cmd-palette__list">
        <Command.Empty className="cmd-palette__empty">{t('palette.empty')}</Command.Empty>

        {!query && recentRoutes.length > 0 && (
          <Command.Group heading={t('palette.groups.recent')} className="cmd-palette__group">
            {recentRoutes.map((r) => (
              <Command.Item
                key={`recent:${r.path}`}
                value={`recent ${r.path}`}
                onSelect={() => go(r.path)}
                className="cmd-palette__item"
              >
                <span className="material-icons-outlined cmd-palette__icon">history</span>
                <span>{r.path}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading={t('palette.groups.pages')} className="cmd-palette__group">
          {PALETTE_ROUTES.map((route) => (
            <Command.Item
              key={route.id}
              value={`page ${t(route.labelKey)} ${route.path}`}
              onSelect={() => go(route.path)}
              className="cmd-palette__item"
            >
              {route.icon && <span className="material-icons-outlined cmd-palette__icon">{route.icon}</span>}
              <span>{t(route.labelKey)}</span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading={t('palette.groups.actions')} className="cmd-palette__group">
          {actions.map((action) => (
            <Command.Item
              key={action.id}
              value={`action ${t(action.labelKey)}`}
              onSelect={() => handleAction(action.id)}
              className="cmd-palette__item"
            >
              {action.icon && <span className="material-icons-outlined cmd-palette__icon">{action.icon}</span>}
              <span>{t(action.labelKey)}</span>
            </Command.Item>
          ))}
        </Command.Group>

        {isAuthenticated && books.length > 0 && (
          <Command.Group heading={t('palette.groups.books')} className="cmd-palette__group">
            {books.map((book) => (
              <Command.Item
                key={book.id}
                value={`book ${book.title} ${book.author ?? ''}`}
                onSelect={() => go(readerPathFor(book))}
                className="cmd-palette__item"
              >
                <span className="material-icons-outlined cmd-palette__icon">menu_book</span>
                <span className="cmd-palette__book-title">{book.title}</span>
                {book.author && <span className="cmd-palette__book-author">{book.author}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="cmd-palette__footer">
        <span><kbd>↑↓</kbd> {t('palette.kbd.navigate')}</span>
        <span><kbd>↵</kbd> {t('palette.kbd.select')}</span>
        <span><kbd>esc</kbd> {t('palette.kbd.close')}</span>
        <span className="cmd-palette__footer-spacer" />
        <span className="cmd-palette__footer-lang">{language.toUpperCase()}</span>
      </div>
    </Command.Dialog>
  )
}
