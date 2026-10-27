import { useEffect, useRef, useState } from 'react'
import {
  adminApi,
  DEFAULT_SITE_ID,
  SeoCoverageStat,
  SeoGapRow,
  SeoTemplateListItem,
  SeoTemplateDetail,
  SeoTemplateUpsert,
  SeoTemplatePreview,
  SeoBackfillJobListItem,
  SeoBackfillJobDetail,
  SeoBackfillSettings,
} from '../api/client'

type PickedEntity = { id: string; label: string }
type QueueInitialValues = {
  entityType: string
  entityId: string
  entityLabel: string
  fields: string[]
  language: string
}

type Tab = 'coverage' | 'templates' | 'jobs' | 'settings'

const ENTITY_TYPES = ['Author', 'Edition', 'Genre'] as const
const FIELD_TYPES = [
  'Bio', 'Description', 'Relevance', 'Themes', 'Faqs',
  'SeoTitle', 'SeoDescription', 'SeoKeywords',
] as const
const LANGUAGES = ['en'] as const
const TRUST_LEVELS = ['Manual', 'Review', 'Auto'] as const

export function SeoBackfillPage() {
  const [tab, setTab] = useState<Tab>('coverage')

  return (
    <div>
      <h1>SEO Backfill</h1>
      <p style={{ color: '#666' }}>
        Automate SEO field generation for Authors, Editions, and Genres using Claude CLI templates.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0', borderBottom: '1px solid #ddd' }}>
        {(['coverage', 'templates', 'jobs', 'settings'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? '#eef' : 'transparent',
              border: 'none',
              borderBottom: tab === t ? '2px solid #55d' : '2px solid transparent',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'coverage' && <CoverageTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  )
}

function CoverageTab() {
  const [stats, setStats] = useState<SeoCoverageStat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gapsFor, setGapsFor] = useState<{ entityType: string; fieldType: string } | null>(null)
  const [queueInit, setQueueInit] = useState<QueueInitialValues | null>(null)

  useEffect(() => {
    adminApi.getSeoCoverage().then(setStats).catch(e => setError(String(e)))
  }, [])

  if (error) return <div style={{ color: 'red' }}>{error}</div>
  if (!stats) return <div>Loading…</div>

  const grouped = stats.reduce<Record<string, SeoCoverageStat[]>>((acc, s) => {
    (acc[s.entityType] ??= []).push(s)
    return acc
  }, {})

  const linkBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', color: '#c33',
    cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline',
  }

  return (
    <div>
      {Object.entries(grouped).map(([entity, rows]) => (
        <div key={entity} style={{ marginBottom: '1.5rem' }}>
          <h3>{entity}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #ddd' }}>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Field</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Populated</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Missing</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Total</th>
                <th style={{ textAlign: 'left', padding: '0.5rem', width: '40%' }}>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const pct = r.total === 0 ? 0 : Math.round((r.populated / r.total) * 100)
                return (
                  <tr key={r.fieldType} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '0.5rem' }}>{r.fieldType}</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right' }}>{r.populated}</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right', color: r.missing > 0 ? '#c33' : '#3a3' }}>
                      {r.missing > 0 ? (
                        <button
                          onClick={() => setGapsFor({ entityType: entity, fieldType: r.fieldType })}
                          style={linkBtn}
                          title="Show entities missing this field"
                        >
                          {r.missing}
                        </button>
                      ) : r.missing}
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'right' }}>{r.total}</td>
                    <td style={{ padding: '0.5rem' }}>
                      <div style={{ background: '#eee', borderRadius: 3, height: 14, position: 'relative' }}>
                        <div style={{ background: pct > 80 ? '#3a3' : pct > 40 ? '#ea0' : '#c33', width: `${pct}%`, height: '100%', borderRadius: 3 }} />
                        <span style={{ position: 'absolute', left: 6, top: -1, fontSize: 11, color: '#222' }}>{pct}%</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      {gapsFor && (
        <MissingEntitiesModal
          entityType={gapsFor.entityType}
          fieldType={gapsFor.fieldType}
          onClose={() => setGapsFor(null)}
          onQueue={init => { setGapsFor(null); setQueueInit(init) }}
        />
      )}
      {queueInit && (
        <QueueEntityModal
          initialValues={queueInit}
          onClose={() => setQueueInit(null)}
          onQueued={() => setQueueInit(null)}
        />
      )}
    </div>
  )
}

function MissingEntitiesModal({
  entityType, fieldType, onClose, onQueue,
}: {
  entityType: string
  fieldType: string
  onClose: () => void
  onQueue: (init: QueueInitialValues) => void
}) {
  const [rows, setRows] = useState<SeoGapRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const FETCH_LIMIT = 500 // server caps at 500

  useEffect(() => {
    adminApi.getSeoGaps({ entityType, limit: FETCH_LIMIT })
      .then(all => {
        setTruncated(all.length >= FETCH_LIMIT)
        setRows(all.filter(g => g.missingFields.includes(fieldType)))
      })
      .catch(e => setError(String(e)))
  }, [entityType, fieldType])

  return (
    <Modal onClose={onClose} title={`${entityType} missing ${fieldType}`} wide>
      {error && <div style={errBox}>{error}</div>}
      {truncated && (
        <div style={{ background: '#fff4e0', border: '1px solid #ea0', color: '#8a5a00', padding: '0.4rem 0.6rem', borderRadius: 4, marginBottom: '0.5rem', fontSize: 12 }}>
          Showing first {FETCH_LIMIT} entities — more may exist. Queue in batches to process all.
        </div>
      )}
      {!rows ? <div>Loading…</div> : rows.length === 0 ? (
        <div style={{ color: '#666' }}>No entities missing {fieldType}.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd' }}>
              <th style={th}>Label</th>
              <th style={th}>Language</th>
              <th style={th}>Other missing</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(g => {
              const other = g.missingFields.filter(f => f !== fieldType)
              return (
                <tr key={`${g.entityId}-${g.language}`} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={td}>
                    <div>{g.label}</div>
                    <div style={{ fontSize: 11, color: '#888', fontFamily: 'ui-monospace, monospace' }}>{g.entityId}</div>
                  </td>
                  <td style={td}>{g.language}</td>
                  <td style={{ ...td, color: '#888', fontSize: 12 }}>{other.length ? other.join(', ') : '—'}</td>
                  <td style={td}>
                    <button
                      onClick={() => onQueue({
                        entityType: g.entityType,
                        entityId: g.entityId,
                        entityLabel: g.label,
                        fields: [fieldType],
                        language: g.language || 'en',
                      })}
                      style={btnSmall}
                    >
                      Queue backfill
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

// ──────────────────────────────── Templates ────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<SeoTemplateListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const [previewing, setPreviewing] = useState<SeoTemplateListItem | null>(null)

  const load = () => {
    adminApi.getSeoTemplates({ onlyActive: !showInactive })
      .then(setTemplates).catch(e => setError(String(e)))
  }

  useEffect(load, [showInactive])

  const onDeactivate = async (t: SeoTemplateListItem) => {
    if (!confirm(`Deactivate template "${t.name}" v${t.version}? Running jobs keep their snapshot.`)) return
    try {
      await adminApi.deactivateSeoTemplate(t.id)
      load()
    } catch (e) { setError(String(e)) }
  }

  if (error) return <div style={{ color: 'red' }}>{error}</div>
  if (!templates) return <div>Loading…</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <p style={{ color: '#666', margin: 0 }}>
          Editing a template creates a new version — existing jobs keep their frozen snapshot.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#666' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Show inactive
          </label>
          <button onClick={() => setEditing({ id: null })} style={btnPrimary}>+ New template</button>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <th style={th}>Name</th>
            <th style={th}>Entity</th>
            <th style={th}>Field</th>
            <th style={th}>Lang</th>
            <th style={th}>Trust</th>
            <th style={{ ...th, textAlign: 'right' }}>Version</th>
            <th style={th}>Status</th>
            <th style={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <tr><td colSpan={8} style={{ padding: '1rem', color: '#888' }}>No templates.</td></tr>
          )}
          {templates.map(t => (
            <tr key={t.id} style={{ borderBottom: '1px solid #f0f0f0', opacity: t.isActive ? 1 : 0.55 }}>
              <td style={td}>{t.name}</td>
              <td style={td}>{t.entityType}</td>
              <td style={td}>{t.fieldType}</td>
              <td style={td}>{t.languageCode}</td>
              <td style={td}>{t.trustLevel}</td>
              <td style={{ ...td, textAlign: 'right' }}>v{t.version}</td>
              <td style={td}>{t.isActive ? 'active' : 'inactive'}</td>
              <td style={td}>
                <button onClick={() => setEditing({ id: t.id })} style={btnSmall}>Edit</button>{' '}
                <button onClick={() => setPreviewing(t)} style={btnSmall}>Preview</button>{' '}
                {t.isActive && <button onClick={() => onDeactivate(t)} style={btnSmallDanger}>Deactivate</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <TemplateEditor
          templateId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
      {previewing && (
        <TemplatePreviewModal template={previewing} onClose={() => setPreviewing(null)} />
      )}
    </div>
  )
}

function TemplateEditor({ templateId, onClose, onSaved }: { templateId: string | null; onClose: () => void; onSaved: () => void }) {
  const isNew = templateId === null
  const [form, setForm] = useState<SeoTemplateUpsert>({
    entityType: 'Author',
    fieldType: 'Bio',
    languageCode: 'en',
    name: '',
    description: '',
    promptTemplate: 'Write a biography for {name}.\n\nReturn JSON: {"bio": "..."}',
    outputSchema: '{"type":"object","required":["bio"],"properties":{"bio":{"type":"string","minLength":100}}}',
    model: 'claude-sonnet-4-6',
    maxTokens: 2000,
    temperature: 0.5,
    trustLevel: 'Review',
  })
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  useEffect(() => {
    if (!templateId) return
    adminApi.getSeoTemplate(templateId)
      .then((t: SeoTemplateDetail) => {
        setForm({
          entityType: t.entityType,
          fieldType: t.fieldType,
          languageCode: t.languageCode,
          name: t.name,
          description: t.description ?? '',
          promptTemplate: t.promptTemplate,
          outputSchema: t.outputSchema,
          model: t.model,
          maxTokens: t.maxTokens,
          temperature: t.temperature,
          trustLevel: t.trustLevel,
        })
        setLoading(false)
      })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [templateId])

  const validateSchema = (s: string) => {
    try { JSON.parse(s); setSchemaError(null); return true }
    catch (e) { setSchemaError(`Invalid JSON: ${(e as Error).message}`); return false }
  }

  const save = async () => {
    if (!validateSchema(form.outputSchema)) return
    if (!form.name.trim()) { setError('Name is required'); return }
    if (!form.promptTemplate.trim()) { setError('Prompt template is required'); return }
    setSaving(true)
    setError(null)
    try {
      if (isNew) await adminApi.createSeoTemplate(form)
      else await adminApi.updateSeoTemplate(templateId!, form)
      onSaved()
    } catch (e) { setError(String(e)) }
    setSaving(false)
  }

  return (
    <Modal onClose={onClose} title={isNew ? 'New template' : 'Edit template (creates new version)'} wide>
      {loading ? <div>Loading…</div> : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {error && <div style={errBox}>{error}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.5rem' }}>
            <Field label="Entity">
              <select value={form.entityType} onChange={e => setForm({ ...form, entityType: e.target.value })} disabled={!isNew} style={input}>
                {ENTITY_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Field">
              <select value={form.fieldType} onChange={e => setForm({ ...form, fieldType: e.target.value })} disabled={!isNew} style={input}>
                {FIELD_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Language">
              <select value={form.languageCode} onChange={e => setForm({ ...form, languageCode: e.target.value })} disabled={!isNew} style={input}>
                {LANGUAGES.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Trust level">
              <select value={form.trustLevel} onChange={e => setForm({ ...form, trustLevel: e.target.value })} style={input}>
                {TRUST_LEVELS.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Name">
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={input} />
          </Field>
          <Field label="Description (optional)">
            <input value={form.description ?? ''} onChange={e => setForm({ ...form, description: e.target.value })} style={input} />
          </Field>

          <Field label="Prompt template (use {placeholder} syntax)">
            <textarea
              value={form.promptTemplate}
              onChange={e => setForm({ ...form, promptTemplate: e.target.value })}
              rows={10} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
          </Field>

          <Field label="Output JSON schema">
            <textarea
              value={form.outputSchema}
              onChange={e => { setForm({ ...form, outputSchema: e.target.value }); validateSchema(e.target.value) }}
              rows={6} style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
            {schemaError && <div style={{ color: '#c33', fontSize: 12, marginTop: 4 }}>{schemaError}</div>}
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.5rem' }}>
            <Field label="Model">
              <input value={form.model ?? ''} onChange={e => setForm({ ...form, model: e.target.value })} style={input} />
            </Field>
            <Field label="Max tokens">
              <input type="number" value={form.maxTokens ?? 2000} onChange={e => setForm({ ...form, maxTokens: Number(e.target.value) })} style={input} />
            </Field>
            <Field label="Temperature">
              <input type="number" step="0.1" min="0" max="2" value={form.temperature ?? 0.5} onChange={e => setForm({ ...form, temperature: Number(e.target.value) })} style={input} />
            </Field>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button onClick={onClose} style={btnSecondary}>Cancel</button>
            <button onClick={save} disabled={saving || !!schemaError} style={btnPrimary}>
              {saving ? 'Saving…' : isNew ? 'Create' : 'Save as new version'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function TemplatePreviewModal({ template, onClose }: { template: SeoTemplateListItem; onClose: () => void }) {
  const [entityId, setEntityId] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SeoTemplatePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!entityId.trim()) { setError('Paste an entity UUID'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await adminApi.previewSeoTemplate(template.id, entityId.trim())
      setResult(r)
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }

  return (
    <Modal onClose={onClose} title={`Preview: ${template.name}`} wide>
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <p style={{ color: '#666', margin: 0, fontSize: 13 }}>
          Renders the template against a real {template.entityType} — no Claude call, just prompt output.
        </p>
        <Field label={`${template.entityType} ID (UUID)`}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input value={entityId} onChange={e => setEntityId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={{ ...input, flex: 1 }} />
            <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? 'Rendering…' : 'Preview'}</button>
          </div>
        </Field>
        {error && <div style={errBox}>{error}</div>}
        {result && (
          <>
            {result.missingPlaceholders.length > 0 && (
              <div style={{ background: '#fff8e1', border: '1px solid #ea0', padding: '0.5rem 0.75rem', borderRadius: 4, fontSize: 13 }}>
                <strong>Missing placeholders:</strong> {result.missingPlaceholders.join(', ')}
              </div>
            )}
            <Field label="Rendered prompt">
              <pre style={codeBlock}>{result.rendered}</pre>
            </Field>
            <Field label="Placeholder values">
              <pre style={codeBlock}>{JSON.stringify(result.values, null, 2)}</pre>
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}

// ──────────────────────────────── Jobs ────────────────────────────────

function JobsTab() {
  const [items, setItems] = useState<SeoBackfillJobListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [queueOpen, setQueueOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = () => {
    adminApi.getSeoJobs({ status: statusFilter || undefined, limit: 50 })
      .then(r => { setItems(r.items); setTotal(r.total) })
      .catch(e => setError(String(e)))
  }

  useEffect(load, [statusFilter])

  const doAction = async (id: string, action: 'approve' | 'revert' | 'retry') => {
    setActionError(null)
    try {
      if (action === 'approve') await adminApi.approveSeoJob(id)
      else if (action === 'revert') await adminApi.revertSeoJob(id)
      else await adminApi.retrySeoJob(id)
      load()
    } catch (e) { setActionError(`${action} failed: ${String(e)}`) }
  }

  if (error) return <div style={{ color: 'red' }}>{error}</div>

  return (
    <div>
      <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <label>
            Filter by status:{' '}
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="Queued">Queued</option>
              <option value="Running">Running</option>
              <option value="NeedsReview">Needs Review</option>
              <option value="Success">Success</option>
              <option value="Failed">Failed</option>
              <option value="Reverted">Reverted</option>
            </select>
          </label>
          <span style={{ marginLeft: '1rem', color: '#666' }}>Total: {total}</span>
        </div>
        <button onClick={() => setQueueOpen(true)} style={btnPrimary}>+ Queue entity</button>
      </div>

      {actionError && (
        <div style={{ background: '#fee', border: '1px solid #c33', color: '#c33', padding: '0.5rem 0.75rem', borderRadius: 4, marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} style={{ background: 'transparent', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
      )}

      {!items ? <div>Loading…</div> : items.length === 0 ? <div style={{ color: '#666' }}>No jobs match.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd' }}>
              <th style={th}>Status</th>
              <th style={th}>Entity</th>
              <th style={th}>Fields</th>
              <th style={th}>Triggered</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(j => (
              <tr key={j.id} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }} onClick={() => setDetailId(j.id)}>
                <td style={td}><StatusBadge status={j.status} /></td>
                <td style={td}>{j.entityType}</td>
                <td style={td}>{j.targetFields.join(', ')}</td>
                <td style={{ ...td, fontSize: 12, color: '#666' }}>{j.triggeredBy}</td>
                <td style={{ ...td, fontSize: 12 }}>{new Date(j.createdAt).toLocaleString()}</td>
                <td style={td} onClick={e => e.stopPropagation()}>
                  {j.status === 'NeedsReview' && <button onClick={() => doAction(j.id, 'approve')} style={btnSmall}>Approve</button>}{' '}
                  {(j.status === 'Success' || j.status === 'NeedsReview') && <button onClick={() => doAction(j.id, 'revert')} style={btnSmallDanger}>Revert</button>}{' '}
                  {(j.status === 'Failed' || j.status === 'Reverted') && <button onClick={() => doAction(j.id, 'retry')} style={btnSmall}>Retry</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {queueOpen && (
        <QueueEntityModal onClose={() => setQueueOpen(false)} onQueued={() => { setQueueOpen(false); load() }} />
      )}
      {detailId && (
        <JobDetailModal id={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  )
}

function QueueEntityModal({
  onClose, onQueued, initialValues,
}: {
  onClose: () => void
  onQueued: () => void
  initialValues?: QueueInitialValues
}) {
  const [entityType, setEntityType] = useState<string>(initialValues?.entityType ?? 'Author')
  const [picked, setPicked] = useState<PickedEntity | null>(
    initialValues ? { id: initialValues.entityId, label: initialValues.entityLabel } : null
  )
  const [fields, setFields] = useState<string[]>(initialValues?.fields ?? ['Bio'])
  const [language, setLanguage] = useState(initialValues?.language ?? 'en')
  const [requireReview, setRequireReview] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleField = (f: string) =>
    setFields(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  const onEntityTypeChange = (t: string) => {
    setEntityType(t)
    setPicked(null)
  }

  const submit = async () => {
    if (!picked) { setError('Select an entity'); return }
    if (fields.length === 0) { setError('Select at least one field'); return }
    setBusy(true); setError(null)
    try {
      await adminApi.queueSeoEntity({ entityType, entityId: picked.id, fields, language, requireReview })
      onQueued()
    } catch (e) { setError(String(e)) }
    setBusy(false)
  }

  return (
    <Modal onClose={onClose} title="Queue SEO backfill">
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {error && <div style={errBox}>{error}</div>}
        <Field label="Entity type">
          <select value={entityType} onChange={e => onEntityTypeChange(e.target.value)} style={input}>
            {ENTITY_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Entity">
          <EntityPicker entityType={entityType} value={picked} onChange={setPicked} />
        </Field>
        <Field label="Fields to backfill">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.25rem' }}>
            {FIELD_TYPES.map(f => (
              <label key={f} style={{ fontSize: 13 }}>
                <input type="checkbox" checked={fields.includes(f)} onChange={() => toggleField(f)} /> {f}
              </label>
            ))}
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <Field label="Language">
            <select value={language} onChange={e => setLanguage(e.target.value)} style={input}>
              {LANGUAGES.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Review gate">
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', height: '100%' }}>
              <input type="checkbox" checked={requireReview} onChange={e => setRequireReview(e.target.checked)} /> Require manual approval
            </label>
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={submit} disabled={busy} style={btnPrimary}>{busy ? 'Queueing…' : 'Queue'}</button>
        </div>
      </div>
    </Modal>
  )
}

function EntityPicker({
  entityType, value, onChange,
}: {
  entityType: string
  value: PickedEntity | null
  onChange: (v: PickedEntity | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickedEntity[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)
  const reqIdRef = useRef(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Clear results when entity type changes (but keep selection — handled by parent)
  useEffect(() => {
    setQuery('')
    setResults([])
    setErr(null)
    setOpen(false)
  }, [entityType])

  // Close dropdown on outside click (no blur/setTimeout race)
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const runSearch = async (q: string) => {
    const reqId = ++reqIdRef.current
    setLoading(true)
    setErr(null)
    try {
      let items: PickedEntity[] = []
      if (entityType === 'Edition') {
        const r = await adminApi.getEditions({ search: q || undefined, limit: 10 })
        items = r.items.map(e => ({ id: e.id, label: `${e.title}${e.language ? ` (${e.language})` : ''}` }))
      } else if (entityType === 'Author') {
        const r = await adminApi.searchAuthors(DEFAULT_SITE_ID, q || undefined, 10)
        items = r.map(a => ({ id: a.id, label: a.name }))
      } else if (entityType === 'Genre') {
        const r = await adminApi.searchGenres(DEFAULT_SITE_ID, q || undefined, 10)
        items = r.map(g => ({ id: g.id, label: g.name }))
      }
      if (reqId === reqIdRef.current) setResults(items)
    } catch (e) {
      if (reqId === reqIdRef.current) setErr(String(e))
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }

  const onQueryChange = (q: string) => {
    setQuery(q)
    setOpen(true)
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => runSearch(q), 250)
  }

  const onFocus = () => {
    setOpen(true)
    if (results.length === 0 && !loading) runSearch(query)
  }

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.5rem', border: '1px solid #ccc', borderRadius: 4, background: '#f9f9ff' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value.label}</div>
          <div style={{ fontSize: 11, color: '#888', fontFamily: 'ui-monospace, monospace' }}>{value.id}</div>
        </div>
        <button
          onClick={() => onChange(null)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#888', fontSize: 18 }}
          title="Clear"
        >×</button>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onFocus={onFocus}
        placeholder={`Search ${entityType.toLowerCase()}…`}
        style={input}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
          background: 'white', border: '1px solid #ccc', borderTop: 'none',
          borderRadius: '0 0 4px 4px', maxHeight: 260, overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        }}>
          {loading && <div style={{ padding: '0.5rem', color: '#888', fontSize: 13 }}>Searching…</div>}
          {err && <div style={{ padding: '0.5rem', color: '#c33', fontSize: 13 }}>{err}</div>}
          {!loading && !err && results.length === 0 && (
            <div style={{ padding: '0.5rem', color: '#888', fontSize: 13 }}>
              {query ? 'No matches.' : 'Start typing to search.'}
            </div>
          )}
          {results.map(r => (
            <div
              key={r.id}
              onMouseDown={e => { e.preventDefault(); onChange(r); setOpen(false) }}
              style={{ padding: '0.4rem 0.6rem', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: 14 }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f5ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'white')}
            >
              <div>{r.label}</div>
              <div style={{ fontSize: 11, color: '#888', fontFamily: 'ui-monospace, monospace' }}>{r.id}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function JobDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [job, setJob] = useState<SeoBackfillJobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminApi.getSeoJob(id).then(setJob).catch(e => setError(String(e)))
  }, [id])

  const renderJson = (raw: string | null) => {
    if (!raw) return <span style={{ color: '#888' }}>—</span>
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
      return <pre style={codeBlock}>{JSON.stringify(obj, null, 2)}</pre>
    } catch {
      return <pre style={codeBlock}>{raw}</pre>
    }
  }

  return (
    <Modal onClose={onClose} title={`Job ${id.slice(0, 8)}…`} wide>
      {error && <div style={errBox}>{error}</div>}
      {!job ? <div>Loading…</div> : (
        <div style={{ display: 'grid', gap: '0.75rem', fontSize: 13 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
            <Kv label="Status"><StatusBadge status={job.status} /></Kv>
            <Kv label="Entity">{job.entityType}</Kv>
            <Kv label="Entity ID">{job.entityId}</Kv>
            <Kv label="Triggered by">{job.triggeredBy}</Kv>
            <Kv label="Created">{new Date(job.createdAt).toLocaleString()}</Kv>
            <Kv label="Started">{job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}</Kv>
            <Kv label="Completed">{job.completedAt ? new Date(job.completedAt).toLocaleString() : '—'}</Kv>
            <Kv label="Review?">{job.requiresReview ? 'yes' : 'no'}</Kv>
          </div>

          <Kv label="Target fields">{job.targetFields.join(', ')}</Kv>
          <Kv label="Template versions">
            {job.templateIds.map((tid, i) => <div key={tid} style={{ fontFamily: 'ui-monospace, monospace' }}>{tid} v{job.templateVersions[i]}</div>)}
          </Kv>

          {job.error && (
            <Field label="Error">
              <pre style={{ ...codeBlock, background: '#fee', borderColor: '#c33' }}>{job.error}</pre>
            </Field>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <Field label="Before snapshot">{renderJson(job.beforeSnapshot)}</Field>
            <Field label="After snapshot">{renderJson(job.afterSnapshot)}</Field>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', color: '#55d' }}>Show rendered prompts + raw outputs</summary>
            <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
              <Field label="Rendered prompts">{renderJson(job.renderedPrompts)}</Field>
              <Field label="Raw Claude outputs">{renderJson(job.rawOutputs)}</Field>
              <Field label="Generated content (parsed)">{renderJson(job.generatedContent)}</Field>
              <Field label="Input snapshot">{renderJson(job.inputSnapshot)}</Field>
            </div>
          </details>
        </div>
      )}
    </Modal>
  )
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'Success' ? '#3a3'
    : status === 'Failed' ? '#c33'
    : status === 'NeedsReview' ? '#ea0'
    : status === 'Running' ? '#55d'
    : status === 'Reverted' ? '#888'
    : '#666'
  return (
    <span style={{ background: color, color: 'white', padding: '2px 8px', borderRadius: 3, fontSize: 12 }}>
      {status}
    </span>
  )
}

// ──────────────────────────────── Settings ────────────────────────────────

function SettingsTab() {
  const [settings, setSettings] = useState<SeoBackfillSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    adminApi.getSeoSettings().then(setSettings).catch(e => setLoadError(String(e)))
  }, [])

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await adminApi.updateSeoSettings(settings)
      setSaved(true)
    } catch (e) { setSaveError(String(e)) }
    setSaving(false)
  }

  if (loadError) return <div style={{ color: 'red' }}>{loadError}</div>
  if (!settings) return <div>Loading…</div>

  return (
    <div style={{ maxWidth: 500 }}>
      <label style={{ display: 'block', marginBottom: '1rem' }}>
        <input type="checkbox" checked={settings.enabled} onChange={e => { setSettings({ ...settings, enabled: e.target.checked }); setSaved(false) }} />
        {' '}Enable backfill poller
      </label>
      <label style={{ display: 'block', marginBottom: '1rem' }}>
        Jobs per run:{' '}
        <input type="number" min={1} max={50} value={settings.jobsPerRun}
          onChange={e => { setSettings({ ...settings, jobsPerRun: Number(e.target.value) }); setSaved(false) }} />
      </label>
      <label style={{ display: 'block', marginBottom: '1rem' }}>
        Interval (seconds):{' '}
        <input type="number" min={10} max={3600} value={settings.intervalSeconds}
          onChange={e => { setSettings({ ...settings, intervalSeconds: Number(e.target.value) }); setSaved(false) }} />
      </label>
      <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
      {saveError && <div style={{ color: '#c33', marginTop: '0.5rem' }}>Save failed: {saveError}</div>}
      {saved && !saveError && <div style={{ color: '#3a3', marginTop: '0.5rem' }}>Saved.</div>}
    </div>
  )
}

// ──────────────────────────────── Shared ────────────────────────────────

function Modal({ children, onClose, title, wide }: { children: React.ReactNode; onClose: () => void; title: string; wide?: boolean }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 6, padding: '1.25rem',
          width: wide ? 'min(900px, 95vw)' : 'min(520px, 95vw)',
          maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: '#888' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>{label}</div>
      {children}
    </label>
  )
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div>{children}</div>
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.5rem', fontWeight: 600, fontSize: 13, color: '#444' }
const td: React.CSSProperties = { padding: '0.5rem' }
const input: React.CSSProperties = { width: '100%', padding: '0.4rem 0.5rem', border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box', fontSize: 14 }
const btnPrimary: React.CSSProperties = { background: '#55d', color: 'white', border: 'none', padding: '0.45rem 0.9rem', borderRadius: 4, cursor: 'pointer', fontSize: 14 }
const btnSecondary: React.CSSProperties = { background: 'white', color: '#444', border: '1px solid #ccc', padding: '0.45rem 0.9rem', borderRadius: 4, cursor: 'pointer', fontSize: 14 }
const btnSmall: React.CSSProperties = { background: '#f5f5f5', color: '#444', border: '1px solid #ddd', padding: '0.25rem 0.6rem', borderRadius: 3, cursor: 'pointer', fontSize: 12 }
const btnSmallDanger: React.CSSProperties = { background: '#fee', color: '#c33', border: '1px solid #fbb', padding: '0.25rem 0.6rem', borderRadius: 3, cursor: 'pointer', fontSize: 12 }
const errBox: React.CSSProperties = { background: '#fee', border: '1px solid #c33', color: '#c33', padding: '0.5rem 0.75rem', borderRadius: 4 }
const codeBlock: React.CSSProperties = { background: '#f6f8fa', border: '1px solid #e1e4e8', borderRadius: 4, padding: '0.5rem', fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'auto', maxHeight: 280, margin: 0, whiteSpace: 'pre-wrap' }
