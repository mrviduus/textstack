import { SeoHead } from '../components/SeoHead'

export function ContactPage() {
  return (
    <div className="static-page">
      <SeoHead
        title="Contact"
        description="Contact TextStack with questions or feedback about the project."
      />
      <h1>Contact</h1>
      <div className="static-page__content">
        <p>
          For questions, feedback, or suggestions, you can reach the project at:
        </p>
        <p>
          <a href="mailto:hello@textstack.app">hello@textstack.app</a>
        </p>
      </div>
    </div>
  )
}
