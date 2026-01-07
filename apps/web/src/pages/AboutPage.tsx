import { SeoHead } from '../components/SeoHead'

export function AboutPage() {
  return (
    <div className="static-page">
      <SeoHead
        title="About TextStack"
        description="Learn about TextStack, an independent online library for reading classic public-domain books."
      />
      <h1>About</h1>
      <div className="static-page__content">
        <p>
          TextStack is an independent online library for reading classic and
          public-domain books.
        </p>
        <p>
          The project focuses on clean typography, calm reading, and simple
          access to literature without distractions.
        </p>
        <p>
          TextStack is built as a long-term project for readers who value depth,
          clarity, and open knowledge.
        </p>
        <h2>Public Domain</h2>
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
