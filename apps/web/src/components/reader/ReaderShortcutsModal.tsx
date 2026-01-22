interface ReaderShortcutsModalProps {
  open: boolean
  onClose: () => void
}

export function ReaderShortcutsModal({ open, onClose }: ReaderShortcutsModalProps) {
  if (!open) return null

  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div className="reader-shortcuts-modal">
        <div className="reader-shortcuts-modal__header">
          <h3>Keyboard Shortcuts</h3>
          <button onClick={onClose} className="reader-shortcuts-modal__close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="reader-shortcuts-modal__content">
          <div className="reader-shortcuts-modal__group">
            <h4>Navigation</h4>
            <div className="reader-shortcuts-modal__item"><kbd>&larr;</kbd><span>Previous page</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>&rarr;</kbd><span>Next page</span></div>
          </div>
          <div className="reader-shortcuts-modal__group">
            <h4>Panels</h4>
            <div className="reader-shortcuts-modal__item"><kbd>S</kbd> or <kbd>/</kbd><span>Search</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>T</kbd><span>Table of contents</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>,</kbd><span>Settings</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>Esc</kbd><span>Close panel</span></div>
          </div>
          <div className="reader-shortcuts-modal__group">
            <h4>Actions</h4>
            <div className="reader-shortcuts-modal__item"><kbd>F</kbd><span>Fullscreen</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>B</kbd><span>Bookmark</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>+</kbd><span>Increase font</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>-</kbd><span>Decrease font</span></div>
          </div>
          <div className="reader-shortcuts-modal__group">
            <h4>Themes</h4>
            <div className="reader-shortcuts-modal__item"><kbd>1</kbd><span>Light</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>2</kbd><span>Sepia</span></div>
            <div className="reader-shortcuts-modal__item"><kbd>3</kbd><span>Dark</span></div>
          </div>
        </div>
      </div>
    </>
  )
}
