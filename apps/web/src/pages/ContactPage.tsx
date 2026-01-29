import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import './LegalPage.css'

export function ContactPage() {
  return (
    <>
      <div className="legal-page">
      <SeoHead
        title="Contact Us - TextStack"
        description="Get in touch with TextStack. We'd love to hear your feedback, questions, or content requests."
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">Contact Us</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">
        We'd love to hear from you. Whether it's feedback, a question, or a book
        request — drop us a line.
      </p>

      <div className="legal-page__contact-card">
        <div className="legal-page__contact-item">
          <span className="material-icons-outlined">mail</span>
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>
        </div>
      </div>

      <section className="legal-page__section">
        <h2>What to Reach Out About</h2>
        <ul>
          <li>Bug reports or technical issues</li>
          <li>Feedback on the reading experience</li>
          <li>Book or author requests</li>
          <li>Questions about the platform</li>
          <li>Partnership or collaboration ideas</li>
        </ul>
      </section>

      <section className="legal-page__section">
        <h2>Response Time</h2>
        <p>
          TextStack is a passion project maintained by a small team. We read every
          message and will do our best to respond promptly, but please allow a few
          days for a reply.
        </p>
      </section>
      </div>
      <Footer />
    </>
  )
}
