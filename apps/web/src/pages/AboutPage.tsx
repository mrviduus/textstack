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
      </div>
    </div>
  )
}
