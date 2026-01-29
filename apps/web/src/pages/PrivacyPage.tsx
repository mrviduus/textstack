import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import './LegalPage.css'

export function PrivacyPage() {
  return (
    <>
      <div className="legal-page">
      <SeoHead
        title="Privacy Policy - TextStack"
        description="TextStack privacy policy. We collect minimal data and respect your privacy. No accounts required for reading."
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">Privacy Policy</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">
        Your privacy matters. TextStack is designed to let you read freely without
        surveillance or data harvesting.
      </p>

      <p className="legal-page__updated">Last updated: January 2025</p>

      <section className="legal-page__section">
        <h2>What We Collect</h2>
        <p>
          TextStack collects minimal data. You can browse and read any book in our
          library without creating an account or providing personal information.
        </p>
        <p>
          If you choose to use optional features like saving reading progress or
          bookmarks, this data is stored locally in your browser. We do not track
          what you read or share this information with third parties.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Cookies</h2>
        <p>
          We use essential cookies only to remember your preferences (like dark mode
          settings). We do not use advertising cookies or tracking pixels.
        </p>
        <p>
          Basic analytics may be collected to understand general usage patterns and
          improve the service, but this data is anonymized and not linked to individual users.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Third Parties</h2>
        <p>
          We do not sell, rent, or share your personal information with third parties.
          We do not display advertisements or use third-party tracking services.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Data Storage</h2>
        <p>
          Reading preferences, progress, and bookmarks are stored locally in your
          browser using standard web storage APIs. You can clear this data at any
          time through your browser settings.
        </p>
        <p>
          If you upload personal books to your library, these files are stored
          securely and are only accessible to you.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Your Rights</h2>
        <p>
          You have the right to access, correct, or delete any personal data we may
          hold. Since we collect minimal data, there's usually nothing to delete —
          but if you have questions, please contact us.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Contact</h2>
        <p>
          If you have questions about this privacy policy, please reach out at{' '}
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>.
        </p>
      </section>
      </div>
      <Footer />
    </>
  )
}
