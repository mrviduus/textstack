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
          Great books deserve a beautiful home. TextStack is an independent
          online library built for readers who value depth, clarity, and the
          timeless power of words.
        </p>
        <p>
          The project focuses on clean typography, calm reading, and simple
          access to literature without distractions. No ads, no accounts
          required, no barriers between you and the text.
        </p>

        <h2>Public Domain</h2>
        <p>All books available on TextStack are in the public domain.</p>
        <p>
          This means the works are no longer protected by copyright and are free
          for anyone to read, share, and reuse. These are the foundational texts
          of human culture — stories, ideas, and wisdom that have shaped
          generations.
        </p>
        <p>
          TextStack exists to make this literary heritage accessible to everyone,
          presented with the care and attention these works deserve.
        </p>

        <h2>The Creator</h2>
        <p>
          Hi, I'm Vasyl Vdovychenko. I built TextStack because I believe in the
          transformative power of reading — and that classic literature should
          be available to anyone, anywhere, without friction.
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
            <span>vasyl.vdov@gmail.com</span>
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
