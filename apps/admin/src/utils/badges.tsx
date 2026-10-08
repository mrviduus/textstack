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

export const formatDate = (date: string | null): string => {
  if (!date) return '-'
  return new Date(date).toLocaleString()
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const getStatusBadge = (status: string) => {
  const classes: Record<string, string> = {
    // Edition statuses
    Draft: 'badge badge--draft',
    Published: 'badge badge--success',
    Deleted: 'badge badge--error',
    // Job statuses
    Queued: 'badge badge--queued',
    Succeeded: 'badge badge--success',
    // Shared
    Processing: 'badge badge--processing',
    Ready: 'badge badge--success',
    Failed: 'badge badge--error',
  }
  return <span className={classes[status] || 'badge'}>{status}</span>
}
