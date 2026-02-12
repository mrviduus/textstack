import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { LocalizedLink } from '../LocalizedLink'

export function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [open])

  if (!user) return null

  const initials = user.name
    ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase()

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        className="user-menu__trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {user.picture ? (
          <img src={user.picture} alt="" className="user-menu__avatar-img" referrerPolicy="no-referrer" />
        ) : (
          <span className="user-menu__avatar">{initials}</span>
        )}
      </button>

      {open && (
        <div className="user-menu__dropdown">
          <div className="user-menu__info">
            <span className="user-menu__name">{user.name || 'User'}</span>
            <span className="user-menu__email">{user.email}</span>
          </div>
          <hr className="user-menu__divider" />
          <LocalizedLink
            to="/library"
            className="user-menu__item"
            onClick={() => setOpen(false)}
          >
            My Library
          </LocalizedLink>
          <LocalizedLink
            to="/stats"
            className="user-menu__item"
            onClick={() => setOpen(false)}
          >
            Stats
          </LocalizedLink>
          <hr className="user-menu__divider" />
          <button
            className="user-menu__item user-menu__item--danger"
            onClick={() => {
              setOpen(false)
              logout()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
