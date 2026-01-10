import { useEffect, useRef } from 'react'
import { useAuth } from '../../context/AuthContext'

export function LoginButton() {
  const { isLoading, isAuthenticated } = useAuth()
  const buttonRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef(false)

  useEffect(() => {
    if (renderedRef.current || isAuthenticated || !buttonRef.current) return
    if (typeof google === 'undefined' || !google.accounts?.id) return

    // Render official Google button
    google.accounts.id.renderButton(buttonRef.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
    })
    renderedRef.current = true
  }, [isAuthenticated])

  if (isLoading) {
    return <span className="login-btn">Loading...</span>
  }

  return <div ref={buttonRef} id="google-signin-button" />
}
