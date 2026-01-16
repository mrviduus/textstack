import { useDownload } from '../context/DownloadContext'

export function DownloadProgressBar() {
  const { downloads, cancelDownload } = useDownload()

  // Get visible downloads (not cancelled)
  const visibleDownloads = Array.from(downloads.values()).filter(
    d => d.status !== 'cancelled'
  )

  if (visibleDownloads.length === 0) return null

  // Show first visible download
  const current = visibleDownloads[0]
  const isError = current.status === 'error'
  const isComplete = current.status === 'complete'

  const dismiss = () => cancelDownload(current.editionId)

  return (
    <div className={`download-bar ${isError ? 'download-bar--error' : ''} ${isComplete ? 'download-bar--complete' : ''}`}>
      <div className="download-bar__icon">
        {isError ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : isComplete ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
      </div>

      <div className="download-bar__info">
        <span className="download-bar__title">{current.title}</span>
        <span className="download-bar__status">
          {isError && current.errorMessage
            ? current.errorMessage
            : isComplete
              ? current.errorMessage || 'Download complete'
              : `${current.downloadedChapters} / ${current.totalChapters} chapters`}
        </span>
      </div>

      {!isError && !isComplete && (
        <>
          <div className="download-bar__progress">
            <div
              className="download-bar__progress-fill"
              style={{ width: `${current.progress}%` }}
            />
          </div>
          <span className="download-bar__percent">{current.progress}%</span>
        </>
      )}

      <button
        className="download-bar__cancel"
        onClick={dismiss}
        title={isError || isComplete ? 'Dismiss' : 'Cancel download'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {visibleDownloads.length > 1 && (
        <span className="download-bar__queue">
          +{visibleDownloads.length - 1} more
        </span>
      )}
    </div>
  )
}
