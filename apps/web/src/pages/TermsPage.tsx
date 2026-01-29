import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import './LegalPage.css'

export function TermsPage() {
  return (
    <>
      <div className="legal-page">
      <SeoHead
        title="Terms of Service - TextStack"
        description="TextStack terms of service. Read about acceptable use, content policies, and your rights as a user."
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">Terms of Service</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">
        By using TextStack, you agree to these terms. They're designed to be
        fair and straightforward.
      </p>

      <p className="legal-page__updated">Last updated: January 2025</p>

      <section className="legal-page__section">
        <h2>Acceptance of Terms</h2>
        <p>
          By accessing or using TextStack, you agree to be bound by these Terms of
          Service. If you disagree with any part of these terms, you may not access
          the service.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Content</h2>
        <p>
          TextStack provides access to public domain literature — works whose copyright
          has expired and that belong to the public. These books are free to read,
          share, and enjoy.
        </p>
        <p>
          Users may upload their own books to their personal library. You are
          responsible for ensuring you have the right to upload and access any
          content you add to the platform.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Acceptable Use</h2>
        <p>You agree to use TextStack respectfully and lawfully. This means:</p>
        <ul>
          <li>Not attempting to disrupt or overload the service</li>
          <li>Not scraping content for commercial purposes</li>
          <li>Not uploading malicious files or content</li>
          <li>Respecting the intellectual property rights of others</li>
        </ul>
      </section>

      <section className="legal-page__section">
        <h2>Intellectual Property</h2>
        <p>
          The public domain books in our library are free for anyone to use.
          However, the TextStack platform, design, and original content are
          protected by copyright.
        </p>
        <p>
          We credit sources where applicable and strive to provide accurate
          information about each work's origin and status.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Disclaimer</h2>
        <p>
          TextStack is provided "as is" without warranties of any kind. While we
          strive to maintain accurate texts and reliable service, we cannot
          guarantee uninterrupted access or error-free content.
        </p>
        <p>
          We are not liable for any damages arising from your use of the service.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Changes to Terms</h2>
        <p>
          We may update these terms from time to time. Significant changes will be
          communicated through the website. Your continued use of TextStack after
          changes constitutes acceptance of the new terms.
        </p>
      </section>

      <section className="legal-page__section">
        <h2>Contact</h2>
        <p>
          Questions about these terms? Reach out at{' '}
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>.
        </p>
      </section>
      </div>
      <Footer />
    </>
  )
}
