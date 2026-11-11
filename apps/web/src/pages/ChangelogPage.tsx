import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import { AREAS, areaOf, readerFeed, type Area, type ChangelogData } from '../lib/changelog'
import './ChangelogPage.css'

const FROZEN_URL = 'https://github.com/mrviduus/textstack/blob/main/CHANGELOG.md'

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })

export function ChangelogPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const tech = params.get('view') === 'all'
  const [area, setArea] = useState<Area | null>(null)
  const [data, setData] = useState<ChangelogData>({ releases: [] })

  // Same-origin file baked into the build; a dev server or a build without it 404s → seed only.
  useEffect(() => {
    let live = true
    fetch('/changelog.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ChangelogData | null) => { if (live && d?.releases) setData(d) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const feed = useMemo(() => readerFeed(data), [data])
  const present = useMemo(() => {
    const seen = new Set<Area | null>(
      tech ? data.releases.flatMap((r) => r.prs.map((p) => areaOf(p.labels))) : feed.flatMap(([, es]) => es.map((e) => e.area)),
    )
    return AREAS.filter((a) => seen.has(a))
  }, [tech, data, feed])

  const setView = (all: boolean) => {
    const next = new URLSearchParams(params)
    if (all) next.set('view', 'all')
    else next.delete('view')
    setParams(next, { replace: true })
    setArea(null)
  }

  const areaTag = (a: Area | null) =>
    a && <span className={`changelog__area changelog__area--${a}`}>{t(`changelog.area.${a}`)}</span>

  const readerGroups = feed
    .map(([date, es]) => [date, es.filter((e) => !area || e.area === area)] as const)
    .filter(([, es]) => es.length)
  const techGroups = data.releases
    .map((r) => ({ ...r, prs: r.prs.filter((p) => !area || areaOf(p.labels) === area) }))
    .filter((r) => r.prs.length)

  return (
    <>
      <div className="changelog">
        <SeoHead title={t('changelog.seoTitle')} description={t('changelog.seoDesc')} />
        <header className="changelog__header">
          <h1 className="changelog__title">{t('changelog.title')}</h1>
          <p className="changelog__intro">{t('changelog.intro')}</p>
        </header>

        <div className="changelog__controls">
          <div className="changelog__switch" role="group" aria-label={t('changelog.viewLabel')}>
            <button type="button" aria-pressed={!tech} onClick={() => setView(false)}>{t('changelog.viewReader')}</button>
            <button type="button" aria-pressed={tech} onClick={() => setView(true)}>{t('changelog.viewTech')}</button>
          </div>
          {present.length > 1 && (
            <div className="changelog__filters" role="group" aria-label={t('changelog.filterLabel')}>
              <button type="button" aria-pressed={area === null} onClick={() => setArea(null)}>{t('changelog.all')}</button>
              {present.map((a) => (
                <button key={a} type="button" aria-pressed={area === a} onClick={() => setArea(a)}>
                  {t(`changelog.area.${a}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        {!tech && readerGroups.map(([date, es]) => (
          <section key={date} className="changelog__day">
            <h2 className="changelog__date"><time dateTime={date}>{formatDate(date)}</time></h2>
            {es.map((e) => (
              <article key={`${e.title}-${e.url ?? ''}`} className="changelog__entry">
                <div className="changelog__meta">
                  {areaTag(e.area)}
                  <span className={`changelog__kind changelog__kind--${e.kind.toLowerCase()}`}>{t(`changelog.kind.${e.kind}`)}</span>
                  <span className="changelog__where">{e.where.join(' · ')}</span>
                </div>
                <h3 className="changelog__entry-title">{e.title}</h3>
                <p className="changelog__text">{e.text}</p>
              </article>
            ))}
          </section>
        ))}

        {tech && techGroups.map((r) => (
          <section key={r.tag ?? 'next'} className="changelog__day">
            <h2 className="changelog__date">
              {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.tag}</a> : t('changelog.unreleased')}
              <time dateTime={r.date}> · {formatDate(r.date)}</time>
            </h2>
            <ul className="changelog__prs">
              {r.prs.map((p) => (
                <li key={p.number}>
                  {areaTag(areaOf(p.labels))}
                  <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {(tech ? techGroups : readerGroups).length === 0 && <p className="changelog__empty">{t('changelog.empty')}</p>}

        <p className="changelog__earlier">
          {t('changelog.earlier')}{' '}
          <a href={FROZEN_URL} target="_blank" rel="noopener noreferrer">CHANGELOG.md</a>.
        </p>
      </div>
      <Footer />
    </>
  )
}
