import { SeoHead } from '../components/SeoHead'
import './AboutPage.css'

export function AboutPage() {
  return (
    <div className="static-page">
      <SeoHead
        title="About TextStack"
        description="TextStack is an independent online library for classic literature. Created by Vasyl Vdovychenko — making timeless books accessible to everyone."
      />
      <h1>About</h1>
      <div className="static-page__content">
        <p className="about-intro">
          TextStack is an independent online library dedicated to public domain
          literature — books that belong to everyone.
        </p>
        <p>
          Every book here is free to read, share, and enjoy. No ads, no
          accounts, no barriers. Just clean typography, calm reading, and
          timeless stories that have shaped generations.
        </p>

        <h2>The Creator</h2>
        <div className="about-creator">
          <img
            src="/images/vasyl-vdovychenko.png"
            alt="Vasyl Vdovychenko"
            className="about-creator__photo"
          />
          <div className="about-creator__info">
            <h3 className="about-creator__name">
              <a
                href="https://vasyl.blog/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Vasyl Vdovychenko
              </a>
            </h3>
            <p className="about-creator__email">vasyl.vdov@gmail.com</p>
          </div>
        </div>
        <p>
          I built TextStack because I believe in the transformative power of
          reading — and that classic literature should be available to anyone,
          anywhere, without friction.
        </p>
        <p>
          This is a long-term passion project. If you share this vision or want
          to connect, I'd love to hear from you.
        </p>
        <div className="about-contact">
          <a href="mailto:vasyl.vdov@gmail.com" className="about-contact__link">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            <span>Email</span>
          </a>

          <a
            href="https://www.linkedin.com/in/vasyl-vdovychenko/"
            target="_blank"
            rel="noopener noreferrer"
            className="about-contact__link"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
              <rect x="2" y="9" width="4" height="12" />
              <circle cx="4" cy="4" r="2" />
            </svg>
            <span>LinkedIn</span>
          </a>

          <a
            href="https://vasyl.blog/"
            target="_blank"
            rel="noopener noreferrer"
            className="about-contact__link"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              <path d="M2 2l7.586 7.586" />
              <circle cx="11" cy="11" r="2" />
            </svg>
            <span>Blog</span>
          </a>
        </div>
      </div>
    </div>
  )
}
