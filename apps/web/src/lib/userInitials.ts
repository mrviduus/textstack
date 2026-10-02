type InitialsUser = {
  id: string
  isGuest?: boolean
  name?: string | null
  email: string
}

export function getUserInitials(user: InitialsUser): string {
  // A guest has no name to take initials from — "G" for Guest, not their synthetic email.
  if (user.isGuest && !user.name) return 'G'
  if (user.name) {
    return user.name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }
  return user.email[0].toUpperCase()
}
