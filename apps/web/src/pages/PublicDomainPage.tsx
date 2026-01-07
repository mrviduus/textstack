import { SeoHead } from '../components/SeoHead'

export function PublicDomainPage() {
  return (
    <div className="static-page">
      <SeoHead
        title="Public Domain Books"
        description="Learn what public domain means and why all books on TextStack are free to read and share."
      />
      <h1>Public Domain</h1>
      <div className="static-page__content">
        <p>All books available on TextStack are in the public domain.</p>
        <p>
          This means the works are no longer protected by copyright and are free
          for anyone to read, share, and reuse.
        </p>
        <p>
          TextStack does not sell books, require accounts, or restrict access to
          the content. The goal of the project is to provide open,
          distraction-free access to classic literature that belongs to
          everyone.
        </p>
      </div>
    </div>
  )
}
