import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import { useLanguage } from '../context/LanguageContext'
import { ConnectAssistant } from '../components/mcp/ConnectAssistant'
import './McpLandingPage.css'

const REMOTE_SNIPPET = `https://textstack.app/mcp`

const CLAUDE_LOCAL_NOW = `{
  "mcpServers": {
    "textstack": {
      "command": "dotnet",
      "args": ["/path/to/TextStack.Ai.Mcp.dll"],
      "env": {
        "TEXTSTACK_API_URL": "https://textstack.app/api",
        "TEXTSTACK_SITE_HOST": "textstack.app"
      }
    }
  }
}`

const TOOL_INSTALL = `dotnet tool install -g TextStack.Mcp`

const CLAUDE_LOCAL_TOOL = `{
  "mcpServers": {
    "textstack": {
      "command": "textstack-mcp",
      "env": {
        "TEXTSTACK_API_URL": "https://textstack.app/api",
        "TEXTSTACK_SITE_HOST": "textstack.app"
      }
    }
  }
}`

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="mcp-code">
      {label && <div className="mcp-code__label">{label}</div>}
      <div className="mcp-code__shell">
        <button type="button" className="mcp-code__copy" onClick={copy} aria-label={t('mcp.copy')}>
          <span className="material-icons-outlined">{copied ? 'check' : 'content_copy'}</span>
          {copied ? t('mcp.copied') : t('mcp.copy')}
        </button>
        <pre className="mcp-code__pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

export function McpLandingPage() {
  const { t } = useTranslation()
  const { getLocalizedPath } = useLanguage()

  const tools: Array<{ name: string; desc: string }> = [
    { name: 'search_books', desc: t('mcp.tools.searchBooks') },
    { name: 'get_book', desc: t('mcp.tools.getBook') },
    { name: 'get_chapter', desc: t('mcp.tools.getChapter') },
    { name: 'search_my_library', desc: t('mcp.tools.searchMyLibrary') },
    { name: 'get_my_book', desc: t('mcp.tools.getMyBook') },
    { name: 'get_my_chapter', desc: t('mcp.tools.getMyChapter') },
    { name: 'save_my_highlight', desc: t('mcp.tools.saveMyHighlight') },
    { name: 'list_my_book_highlights', desc: t('mcp.tools.listMyBookHighlights') },
    { name: 'list_my_highlights', desc: t('mcp.tools.listMyHighlights') },
    { name: 'save_highlight', desc: t('mcp.tools.saveHighlight') },
    { name: 'list_my_vocabulary', desc: t('mcp.tools.listMyVocabulary') },
    { name: 'save_insight', desc: t('mcp.tools.saveInsight') },
    { name: 'get_my_insights', desc: t('mcp.tools.getMyInsights') },
  ]

  return (
    <>
      <div className="mcp-page">
        <SeoHead title={t('mcp.seoTitle')} description={t('mcp.seoDescription')} />

        <header className="mcp-page__header">
          <h1 className="mcp-page__title">{t('mcp.title')}</h1>
          <div className="mcp-page__accent-bar" />
          <p className="mcp-page__intro">{t('mcp.intro')}</p>
        </header>

        <section className="mcp-section">
          <h2 className="mcp-section__heading">{t('mcp.remote.heading')}</h2>
          <p className="mcp-section__lead">{t('mcp.remote.lead')}</p>
          <CodeBlock code={REMOTE_SNIPPET} label={t('mcp.remote.endpointLabel')} />
          <ul className="mcp-list">
            <li>{t('mcp.remote.transport')}</li>
            <li>{t('mcp.remote.addServer')}</li>
            <li>{t('mcp.remote.publicTools')}</li>
          </ul>
          <div className="mcp-note">
            <span className="material-icons-outlined">lock</span>
            <p>
              {t('mcp.remote.authNote')}{' '}
              <Link to={getLocalizedPath('/device')} className="mcp-link">
                {t('mcp.remote.deviceLink')}
              </Link>
            </p>
          </div>
        </section>

        <ConnectAssistant />

        <section className="mcp-section">
          <h2 className="mcp-section__heading">{t('mcp.local.heading')}</h2>
          <p className="mcp-section__lead">{t('mcp.local.lead')}</p>

          <h3 className="mcp-section__subheading">{t('mcp.local.nowLabel')}</h3>
          <p className="mcp-section__hint">{t('mcp.local.nowHint')}</p>
          <CodeBlock code={CLAUDE_LOCAL_NOW} label="claude_desktop_config.json" />

          <h3 className="mcp-section__subheading">{t('mcp.local.toolLabel')}</h3>
          <p className="mcp-section__hint">{t('mcp.local.toolHint')}</p>
          <CodeBlock code={TOOL_INSTALL} label={t('mcp.local.toolInstallLabel')} />
          <CodeBlock code={CLAUDE_LOCAL_TOOL} label="claude_desktop_config.json" />
        </section>

        <section className="mcp-section">
          <h2 className="mcp-section__heading">{t('mcp.tools.heading')}</h2>
          <p className="mcp-section__lead">{t('mcp.tools.lead')}</p>
          <ul className="mcp-tools">
            {tools.map((tool) => (
              <li key={tool.name} className="mcp-tools__item">
                <code className="mcp-tools__name">{tool.name}</code>
                <span className="mcp-tools__desc">{tool.desc}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mcp-section">
          <h2 className="mcp-section__heading">{t('mcp.steps.heading')}</h2>
          <ol className="mcp-steps">
            <li>{t('mcp.steps.step1')}</li>
            <li>{t('mcp.steps.step2')}</li>
            <li>{t('mcp.steps.step3')}</li>
          </ol>
        </section>

        <p className="mcp-manifest">
          {t('mcp.manifest.label')}{' '}
          <a
            href="https://textstack.app/.well-known/mcp/manifest.json"
            className="mcp-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://textstack.app/.well-known/mcp/manifest.json
          </a>
        </p>
      </div>
      <Footer />
    </>
  )
}
