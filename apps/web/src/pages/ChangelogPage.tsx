import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import { AREAS, areaOf, byWeek, readerEntries, type Area, type ChangelogData } from '../lib/changelog'
import './ChangelogPage.css'

const FROZEN_URL = 'https://github.com/mrviduus/textstack/blob/main/CHANGELOG.md'

const formatDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })

export function ChangelogPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const tech = params.get('view') === 'all'
  const [area, setArea] = useState<Area | null>(null)
  const [data, setData] = useState<ChangelogData>({ prs: [] })

  // Same-origin file baked into the build; a dev server or a build without it 404s → seed only.
  useEffect(() => {
    let live = true
    fetch('/changelog.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ChangelogData | null) => { if (live && Array.isArray(d?.prs)) setData(d) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const entries = useMemo(() => readerEntries(data), [data])
  const present = useMemo(() => {
    const seen = new Set<Area | null>(tech ? data.prs.map((p) => areaOf(p.labels)) : entries.map((e) => e.area))
    return AREAS.filter((a) => seen.has(a))
  }, [tech, data, entries])

  const setView = (all: boolean) => {
    const next = new URLSearchParams(params)
    if (all) next.set('view', 'all')
    else next.delete('view')
    setParams(next, { replace: true })
    setArea(null)
  }

  const areaTag = (a: Area | null) =>
    a && <span className={`changelog__area changelog__area--${a}`}>{t(`changelog.area.${a}`)}</span>

  const readerGroups = byWeek(entries.filter((e) => !area || e.area === area), (e) => e.date)
  const techGroups = byWeek(data.prs.filter((p) => !area || areaOf(p.labels) === area), (p) => p.mergedAt)
  const weekHeading = (week: string) => (
    <h2 className="changelog__date"><time dateTime={week}>{t('changelog.weekOf', { date: formatDate(week) })}</time></h2>
  )

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

        {!tech && readerGroups.map(([week, es]) => (
          <section key={week} className="changelog__day">
            {weekHeading(week)}
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

        {tech && techGroups.map(([week, prs]) => (
          <section key={week} className="changelog__day">
            {weekHeading(week)}
            <ul className="changelog__prs">
              {prs.map((p) => (
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
