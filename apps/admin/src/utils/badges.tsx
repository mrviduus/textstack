// Status badge helpers for job pages

export const getJobStatusClass = (status: string): string => {
  const classes: Record<string, string> = {
    Queued: 'badge badge--queued',
    Running: 'badge badge--processing',
    Completed: 'badge badge--success',
    Failed: 'badge badge--error',
    Cancelled: 'badge badge--cancelled',
  }
  return classes[status] || 'badge'
}

export const getModeClass = (mode: string): string => {
  const classes: Record<string, string> = {
    Full: 'badge badge--info',
    Incremental: 'badge badge--warning',
    Specific: 'badge badge--secondary',
  }
  return classes[mode] || 'badge'
}

export const getRouteTypeBadge = (type: string) => {
  const classes: Record<string, string> = {
    book: 'badge badge--book',
    author: 'badge badge--author',
    genre: 'badge badge--genre',
    static: 'badge badge--secondary',
  }
  return <span className={classes[type] || 'badge'}>{type}</span>
}

export const getHttpStatusClass = (status: number): string => {
  if (status >= 200 && status < 300) return 'badge badge--success'
  if (status >= 300 && status < 400) return 'badge badge--redirect'
  if (status >= 400 && status < 500) return 'badge badge--client-error'
  if (status >= 500) return 'badge badge--server-error'
  return 'badge'
}

export const formatDate = (date: string | null): string => {
  if (!date) return '-'
  return new Date(date).toLocaleString()
}
