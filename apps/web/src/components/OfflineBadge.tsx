import { useState, useEffect } from 'react'
import { getCachedBookMeta, isBookFullyCached } from '../lib/offlineDb'
import { useDownload } from '../context/DownloadContext'

interface OfflineBadgeProps {
  editionId: string
  className?: string
}

export function OfflineBadge({ editionId, className = '' }: OfflineBadgeProps) {
  const [status, setStatus] = useState<'none' | 'partial' | 'full'>('none')
  const { isDownloading } = useDownload()
  const downloading = isDownloading(editionId)

  useEffect(() => {
    let mounted = true

    const checkStatus = async () => {
      try {
        const isFull = await isBookFullyCached(editionId)
        if (!mounted) return

        if (isFull) {
          setStatus('full')
        } else {
          const meta = await getCachedBookMeta(editionId)
          if (!mounted) return
          setStatus(meta && meta.cachedChapters > 0 ? 'partial' : 'none')
        }
      } catch {
        if (mounted) setStatus('none')
      }
    }

    checkStatus()

    // Re-check periodically during download
    const interval = setInterval(checkStatus, 3000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [editionId])

  if (status === 'none') return null

  // Determine icon and title based on status + active download
  const isActiveDownload = status === 'partial' && downloading
  const isPaused = status === 'partial' && !downloading

  const title = status === 'full'
    ? 'Available offline'
    : isActiveDownload
      ? 'Downloading...'
      : 'Paused - tap menu to resume'

  return (
    <span
      className={`offline-badge offline-badge--${status} ${className}`}
      title={title}
    >
      {status === 'full' ? (
        // Checkmark for fully downloaded
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v10m0 0l-3-3m3 3l3-3" />
          <path d="M20 17v.8a3 3 0 01-2.82 2.99H6.82A3 3 0 014 17.8V17" />
        </svg>
      ) : isActiveDownload ? (
        // Spinner for active download
        <span className="offline-badge__spinner" />
      ) : isPaused ? (
        // Pause icon for partial/paused download
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      ) : null}
    </span>
  )
}
