import { useEffect, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'

export function LoginButton() {
  const { isLoading } = useAuth()
  const buttonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof google === 'undefined' || !google.accounts?.id) return
    if (buttonRef.current && !buttonRef.current.hasChildNodes()) {
      google.accounts.id.renderButton(buttonRef.current, {
        type: 'icon',
        theme: 'outline',
        size: 'large',
        shape: 'circle',
      })
    }
  }, [])

  if (isLoading) {
    return null
  }

  return <div ref={buttonRef} className="login-btn-google" />
}
