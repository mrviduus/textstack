import { useState, useEffect, CSSProperties } from 'react'
import {
  adminApi,
  AiQualitySummary,
  BudgetStatus,
  FeatureSummary,
  DailyCostPoint,
  TraceListItem,
  TraceDetail,
  AgentRunListItem,
  AgentRunDetail,
  EvalRun,
  CriticDefectEvalResult,
  CrewAbEvalResult,
  EnrichmentEvalResult,
  TutorEvalResult,
  ShadowSummary,
  ShadowPair,
  ShadowSample,
  ModelRegistration,
  ModelPromotionResult,
  DriftPoint,
  DriftAlertState,
  ScheduledEvalPoint,
} from '../api/client'

type Tab = 'summary' | 'traces' | 'transcripts' | 'evals' | 'shadow' | 'models' | 'drift'

const KNOWN_FEATURES = ['explain', 'translate', 'distractor', 'bookmeta', 'tagsuggestion', 'eval.judge']

export function AiQualityPage() {
  const [tab, setTab] = useState<Tab>('summary')
  return (
    <div className="dashboard-page">
      <h1>AI Quality</h1>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', margin: '12px 0 16px' }}>
        {(['summary', 'traces', 'transcripts', 'evals', 'shadow', 'models', 'drift'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
              background: 'none',
              color: tab === t ? '#2563eb' : '#6b7280',
              fontWeight: tab === t ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'summary' && <SummaryTab />}
      {tab === 'traces' && <TracesTab />}
      {tab === 'transcripts' && <TranscriptsTab />}
      {tab === 'evals' && <EvalsTab />}
      {tab === 'shadow' && <ShadowTab />}
      {tab === 'models' && <ModelsTab />}
      {tab === 'drift' && <DriftTab />}
    </div>
  )
}

// ─────────────────────────── Summary ───────────────────────────

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

function SummaryTab() {
  const [data, setData] = useState<AiQualitySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(30)

  useEffect(() => {
    setLoading(true)
    const from = new Date(Date.now() - days * 86400000).toISOString()
    adminApi
      .getAiQualitySummary({ from })
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [days])

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <p className="dashboard-page__subtitle" style={{ margin: 0 }}>
          Per-feature cost, latency and error rate from sampled LLM traces.
        </p>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} style={rangeBtn(days === r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : !data || data.features.length === 0 ? (
        <p className="dashboard-empty" style={{ marginTop: 24 }}>
          No LLM traces in this window yet. Traces are sampled, so metrics appear once the app makes AI calls.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 24, margin: '16px 0' }}>
            <Totals label="Total calls" value={data.totalCalls.toLocaleString()} />
            <Totals label="Total cost" value={`$${data.totalCostUsd.toFixed(2)}`} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {data.features.map((f) => (
              <FeatureCard key={f.featureTag} f={f} />
            ))}
          </div>
        </>
      )}

      <BudgetsSection />
    </>
  )
}

// ─────────────────────────── Budgets ───────────────────────────

function budgetBarColor(pctUsed: number): string {
  if (pctUsed >= 1) return '#dc2626' // red, over budget
  if (pctUsed >= 0.8) return '#d97706' // amber, near budget
  return '#059669' // green
}

function BudgetsSection() {
  const [budgets, setBudgets] = useState<BudgetStatus[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getBudgets()
      .then((d) => {
        setBudgets(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  // Only show features that actually have a budget or are not "off" — the rest are noise.
  const rows = (budgets ?? []).filter((b) => b.dailyBudgetUsd != null || b.mode !== 'off')

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Daily budgets</h2>
      <p className="dashboard-page__subtitle" style={{ margin: '0 0 12px' }}>
        Per-feature spend today vs the configured daily cap.
      </p>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="dashboard-empty">
          No daily budgets configured. Set Ai:Budgets:Features:&#123;feature&#125; to cap per-feature spend (over-budget
          routes to a cheaper fallback or 429).
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>Feature</th>
              <th style={th}>Today</th>
              <th style={th}>Budget</th>
              <th style={{ ...th, minWidth: 160 }}>% used</th>
              <th style={th}>Mode</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const pct = Math.min(100, Math.max(0, b.pctUsed * 100))
              const color = budgetBarColor(b.pctUsed)
              return (
                <tr key={b.featureTag} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={td}>{b.featureTag}</td>
                  <td style={td}>${b.todaySpendUsd.toFixed(4)}</td>
                  <td style={td}>{b.dailyBudgetUsd != null ? `$${b.dailyBudgetUsd.toFixed(4)}` : '—'}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: '#f3f4f6', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
                      </div>
                      <span style={{ fontWeight: 600, color, minWidth: 42, textAlign: 'right' }}>
                        {(b.pctUsed * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td style={td}>{b.mode}</td>
                  <td style={td}>
                    {b.inFallback && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          color: '#92400e',
                          background: '#fef3c7',
                          borderRadius: 4,
                          padding: '2px 8px',
                        }}
                      >
                        in fallback{b.fallbackKey ? ` · ${b.fallbackKey}` : ''}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Totals({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>{value}</div>
      <div style={{ fontSize: 13, color: '#6b7280' }}>{label}</div>
    </div>
  )
}

function FeatureCard({ f }: { f: FeatureSummary }) {
  const errPct = (f.errorRate * 100).toFixed(1)
  const errColor = f.errorRate > 0.05 ? '#dc2626' : f.errorRate > 0 ? '#d97706' : '#059669'
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>{f.featureTag}</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{f.calls.toLocaleString()} calls</span>
      </div>
      <Sparkline points={f.dailyCost} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginTop: 12 }}>
        <Metric label="Cost" value={`$${f.costUsd.toFixed(4)}`} />
        <Metric label="Cost/day" value={`$${f.costPerDay.toFixed(4)}`} />
        <Metric label="p50 latency" value={`${f.p50LatencyMs} ms`} />
        <Metric label="p95 latency" value={`${f.p95LatencyMs} ms`} />
        <Metric label="Error rate" value={`${errPct}%`} color={errColor} />
        <Metric label="Tokens (in/out)" value={`${f.tokensIn.toLocaleString()} / ${f.tokensOut.toLocaleString()}`} />
        {f.latestEvalScore != null && (
          <Metric label="Eval score" value={`${f.latestEvalScore.toFixed(2)} / 5`} color="#7c3aed" />
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: color ?? '#111827' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
    </div>
  )
}

function Sparkline({ points }: { points: DailyCostPoint[] }) {
  const w = 248
  const h = 36
  const pad = 2
  if (points.length < 2) return <div style={{ height: h, color: '#d1d5db', fontSize: 12 }}>—</div>
  const vals = points.map((p) => p.costUsd)
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const range = max - min || 1
  const step = (w - pad * 2) / (points.length - 1)
  const coords = points
    .map((p, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((p.costUsd - min) / range) * (h - pad * 2)).toFixed(1)}`)
    .join(' ')
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={coords} fill="none" stroke="#2563eb" strokeWidth="1.5" />
    </svg>
  )
}

// ─────────────────────────── Traces ───────────────────────────

const PAGE = 50

function TracesTab() {
  const [items, setItems] = useState<TraceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [feature, setFeature] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TraceDetail | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getAiTraces({ feature: feature || undefined, q: q || undefined, limit: PAGE, offset })
      .then((d) => {
        setItems(d.items)
        setTotal(d.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [feature, q, offset])

  const openTrace = async (id: string) => {
    try {
      setSelected(await adminApi.getAiTrace(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trace')
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select
          value={feature}
          onChange={(e) => {
            setOffset(0)
            setFeature(e.target.value)
          }}
          style={input}
        >
          <option value="">All features</option>
          {KNOWN_FEATURES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          placeholder="Search prompt / response…"
          defaultValue={q}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOffset(0)
              setQ((e.target as HTMLInputElement).value)
            }
          }}
          style={{ ...input, flex: 1, minWidth: 200 }}
        />
      </div>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : items.length === 0 ? (
        <p className="dashboard-empty">No traces match. (Traces are sampled and only appear after AI calls.)</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Feature</th>
                <th style={th}>Model</th>
                <th style={th}>Cost</th>
                <th style={th}>Latency</th>
                <th style={th}>Tokens</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openTrace(t.id)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6', background: t.hasError ? '#fef2f2' : undefined }}
                >
                  <td style={td}>{t.featureTag}{t.hasError && <span style={{ color: '#dc2626' }}> ⚠</span>}</td>
                  <td style={td}>{t.modelId}</td>
                  <td style={td}>${t.costUsd.toFixed(4)}</td>
                  <td style={td}>{t.latencyMs} ms</td>
                  <td style={td}>{t.tokensIn}/{t.tokensOut}</td>
                  <td style={td}>{timeAgo(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} total={total} onChange={setOffset} />
        </>
      )}

      {selected && <TraceModal trace={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

function TraceModal({ trace, onClose }: { trace: TraceDetail; onClose: () => void }) {
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{trace.featureTag}</h2>
          <button onClick={onClose} style={{ ...rangeBtn(false), border: 'none' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          {trace.modelId} · ${trace.costUsd.toFixed(4)} · {trace.latencyMs} ms · {trace.tokensIn}/{trace.tokensOut} tok · {new Date(trace.createdAt).toLocaleString()}
        </div>
        {trace.error && <Banner text={trace.error} />}
        <Section title="System prompt" body={trace.systemPrompt} />
        <Section title="Messages" body={pretty(trace.messagesJson)} />
        <Section title="Response" body={trace.responseText} />
        {trace.toolCallsJson && <Section title="Tool calls" body={pretty(trace.toolCallsJson)} />}
      </div>
    </div>
  )
}

function Section({ title, body }: { title: string; body: string | null }) {
  if (!body) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>{title}</div>
      <pre style={pre}>{body}</pre>
    </div>
  )
}

// ─────────────────────────── Transcripts ───────────────────────────

const RUN_PAGE = 25
const AGENT_FILTERS = ['crew.autopublish', 'crew.seo', 'tutor']

function isErrorStatus(status: string, hasError?: boolean): boolean {
  return hasError === true || status === 'error' || status === 'budget_exhausted'
}

function TranscriptsTab() {
  const [items, setItems] = useState<AgentRunListItem[]>([])
  const [total, setTotal] = useState(0)
  const [agent, setAgent] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AgentRunDetail | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getAgentRuns({ agent: agent || undefined, limit: RUN_PAGE, offset })
      .then((d) => {
        setItems(d.items)
        setTotal(d.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [agent, offset])

  const openRun = async (id: string) => {
    try {
      setSelected(await adminApi.getAgentRun(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transcript')
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select
          value={agent}
          onChange={(e) => {
            setOffset(0)
            setAgent(e.target.value)
          }}
          style={input}
        >
          <option value="">All agents</option>
          {AGENT_FILTERS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : items.length === 0 ? (
        <p className="dashboard-empty">No agent runs match. (Crew/agent transcripts appear after the app runs an agent.)</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Agent</th>
                <th style={th}>Status</th>
                <th style={th}>Goal</th>
                <th style={th}>Cost</th>
                <th style={th}>Tokens</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const err = isErrorStatus(r.status, r.hasError)
                return (
                  <tr
                    key={r.id}
                    onClick={() => openRun(r.id)}
                    style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6', background: err ? '#fef2f2' : undefined }}
                  >
                    <td style={td}>{r.agent}{err && <span style={{ color: '#dc2626' }}> ⚠</span>}</td>
                    <td style={td}>{r.status}</td>
                    <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.goal}</td>
                    <td style={td}>${r.costUsd.toFixed(4)}</td>
                    <td style={td}>{r.tokensIn}/{r.tokensOut}</td>
                    <td style={td}>{timeAgo(r.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <Pager offset={offset} total={total} onChange={setOffset} pageSize={RUN_PAGE} label="runs" />
        </>
      )}

      {selected && <TranscriptModal run={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

function statusColor(status: string, hasError?: boolean): string {
  if (isErrorStatus(status, hasError)) return '#dc2626'
  if (status === 'completed') return '#059669'
  return '#6b7280'
}

function TranscriptModal({ run, onClose }: { run: AgentRunDetail; onClose: () => void }) {
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
            {run.agent}
            <span style={{ fontSize: 12, fontWeight: 600, color: statusColor(run.status, run.error != null) }}>
              {run.status}
            </span>
          </h2>
          <button onClick={onClose} style={{ ...rangeBtn(false), border: 'none' }}>✕</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px 12px', marginBottom: 12 }}>
          <Metric label="Iterations" value={String(run.iterations)} />
          <Metric label="Cost" value={`$${run.costUsd.toFixed(4)}`} />
          <Metric label="Latency" value={`${run.latencyMs} ms`} />
          <Metric label="Tokens (in/out)" value={`${run.tokensIn} / ${run.tokensOut}`} />
          <Metric label="When" value={new Date(run.createdAt).toLocaleString()} />
        </div>
        {run.error && <Banner text={run.error} />}
        <Section title="Goal" body={run.goal} />
        <Section title="Output" body={run.output ?? null} />
        <StepTree stepsJson={run.stepsJson} />
      </div>
    </div>
  )
}

// PascalCase shapes from the backend transcript JSON.
interface AgentStep {
  Index?: number
  Kind?: string
  Payload?: unknown
  At?: string
}
interface SubAgentUsage {
  Iterations?: number
  InputTokensTotal?: number
  OutputTokensTotal?: number
  CostUsdTotal?: number
  LatencyMs?: number
}
interface SubAgentPayload {
  stage?: string
  agentName?: string
  status?: string
  usage?: SubAgentUsage
  steps?: AgentStep[]
}

function StepTree({ stepsJson }: { stepsJson: string }) {
  let steps: AgentStep[]
  try {
    const parsed = JSON.parse(stepsJson)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    steps = parsed as AgentStep[]
  } catch {
    return <Section title="Steps (raw)" body={pretty(stepsJson)} />
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 6 }}>Steps</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step, i) => (
          <StepNode key={i} step={step} />
        ))}
      </div>
    </div>
  )
}

function StepNode({ step }: { step: AgentStep }) {
  try {
    if (step.Kind === 'sub_agent') {
      return <SubAgentPanel payload={step.Payload as SubAgentPayload} />
    }
    return (
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>{step.Kind ?? 'step'}</div>
        <pre style={pre}>{pretty(JSON.stringify(step.Payload))}</pre>
      </div>
    )
  } catch {
    return (
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>step</div>
        <pre style={pre}>{pretty(JSON.stringify(step))}</pre>
      </div>
    )
  }
}

function SubAgentPanel({ payload }: { payload: SubAgentPayload }) {
  const p = payload ?? {}
  const isCritic = p.agentName === 'critic'
  const [open, setOpen] = useState(isCritic) // critic default-expanded, others collapsed
  const usage = p.usage ?? {}
  const title = `${p.stage ?? '?'} · ${p.agentName ?? '?'}`
  return (
    <div style={card}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
      >
        <span style={{ color: '#9ca3af', fontSize: 12 }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{title}</span>
        {p.status && (
          <span style={{ fontSize: 11, fontWeight: 600, color: statusColor(p.status), textTransform: 'uppercase' }}>{p.status}</span>
        )}
      </button>
      {open && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px 12px', margin: '12px 0' }}>
            <Metric label="Iterations" value={String(usage.Iterations ?? '—')} />
            <Metric label="Tokens (in/out)" value={`${usage.InputTokensTotal ?? 0} / ${usage.OutputTokensTotal ?? 0}`} />
            <Metric label="Cost" value={`$${(usage.CostUsdTotal ?? 0).toFixed(4)}`} />
            <Metric label="Latency" value={`${usage.LatencyMs ?? 0} ms`} />
          </div>
          <SubAgentBody payload={p} isCritic={isCritic} />
        </>
      )}
    </div>
  )
}

function SubAgentBody({ payload, isCritic }: { payload: SubAgentPayload; isCritic: boolean }) {
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  if (isCritic) {
    const text = firstLlmResponseText(steps)
    if (text != null) {
      return <CriticReview text={text} />
    }
  }
  if (steps.length === 0) {
    return <pre style={pre}>{pretty(JSON.stringify(payload))}</pre>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map((s, i) => {
        try {
          const inner = s.Payload as { text?: string } | undefined
          const body = inner && typeof inner.text === 'string' ? inner.text : pretty(JSON.stringify(s.Payload))
          return (
            <div key={i}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>{s.Kind ?? 'step'}</div>
              <pre style={pre}>{body}</pre>
            </div>
          )
        } catch {
          return <pre key={i} style={pre}>{pretty(JSON.stringify(s))}</pre>
        }
      })}
    </div>
  )
}

function firstLlmResponseText(steps: AgentStep[]): string | null {
  for (const s of steps) {
    if (s.Kind === 'llm_response') {
      const inner = s.Payload as { text?: string } | undefined
      if (inner && typeof inner.text === 'string') return inner.text
    }
  }
  // fall back to any step that carries a text payload
  for (const s of steps) {
    const inner = s.Payload as { text?: string } | undefined
    if (inner && typeof inner.text === 'string') return inner.text
  }
  return null
}

interface CriticScores {
  factual_accuracy?: number
  tone?: number
  length?: number
  banned_phrases?: number
}
interface CriticIssue {
  severity?: string
  axis?: string
  message?: string
  detail?: string
}

function CriticReview({ text }: { text: string }) {
  let parsed: { scores?: CriticScores; issues?: CriticIssue[] }
  try {
    parsed = JSON.parse(text)
  } catch {
    return <pre style={pre}>{pretty(text)}</pre>
  }
  const scores = parsed.scores ?? {}
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px 12px' }}>
        <Metric label="Factual accuracy" value={fmtScore(scores.factual_accuracy)} />
        <Metric label="Tone" value={fmtScore(scores.tone)} />
        <Metric label="Length" value={fmtScore(scores.length)} />
        <Metric label="Banned phrases" value={fmtScore(scores.banned_phrases)} />
      </div>
      {issues.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {issues.map((iss, i) => (
            <div
              key={i}
              style={{
                borderLeft: `3px solid ${severityColor(iss.severity)}`,
                background: '#f9fafb',
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600, color: severityColor(iss.severity), textTransform: 'uppercase', fontSize: 11 }}>
                {iss.severity ?? 'issue'}
              </span>
              {iss.axis && <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 11 }}>{iss.axis}</span>}
              <div style={{ color: '#374151', marginTop: 2 }}>{iss.message ?? iss.detail ?? ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function fmtScore(v: number | undefined): string {
  return v == null ? '—' : String(v)
}

function severityColor(severity?: string): string {
  if (severity === 'blocker') return '#dc2626'
  if (severity === 'major') return '#d97706'
  return '#6b7280' // minor / unknown
}

// ─────────────────────────── Evals ───────────────────────────

function EvalsTab() {
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [judge, setJudge] = useState<'ollama' | 'openai'>('ollama')
  const [running, setRunning] = useState(false)
  const [criticRunning, setCriticRunning] = useState(false)
  const [criticResult, setCriticResult] = useState<CriticDefectEvalResult | null>(null)
  const [crewAbRunning, setCrewAbRunning] = useState(false)
  const [crewAbResult, setCrewAbResult] = useState<CrewAbEvalResult | null>(null)
  const [enrichmentRunning, setEnrichmentRunning] = useState(false)
  const [enrichmentResult, setEnrichmentResult] = useState<EnrichmentEvalResult | null>(null)
  const [tutorRunning, setTutorRunning] = useState(false)
  const [tutorResult, setTutorResult] = useState<TutorEvalResult | null>(null)

  const load = () =>
    adminApi
      .getAiEvals({ limit: 500 })
      .then((d) => {
        setRuns(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))

  useEffect(() => {
    load().finally(() => setLoading(false))
    let prev = false
    const poll = setInterval(async () => {
      try {
        const st = await adminApi.getAiEvalStatus()
        setRunning(st.running)
        if (st.lastError) setError(st.lastError)
        if (prev && !st.running) load() // finished → refresh history
        prev = st.running
      } catch {
        /* ignore poll errors */
      }
    }, 3000)
    return () => clearInterval(poll)
  }, [])

  const run = async () => {
    setError(null)
    try {
      await adminApi.runAiEvals({ judge })
      setRunning(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start run')
    }
  }

  const runCriticDefect = async () => {
    setError(null)
    setCriticRunning(true)
    try {
      setCriticResult(await adminApi.runCriticDefectEval())
      load() // persisted as an eval_run → refresh history
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run critic-defect eval')
    } finally {
      setCriticRunning(false)
    }
  }

  const runCrewAb = async () => {
    setError(null)
    setCrewAbRunning(true)
    try {
      setCrewAbResult(await adminApi.runCrewAbEval())
      load() // persisted as a crew_ab eval_run → refresh history
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run crew A/B eval')
    } finally {
      setCrewAbRunning(false)
    }
  }

  // Backend returns Results.Problem(..., 503) with a problem-details body when the host has no
  // OpenAI key — surface that as a clear hint rather than the raw JSON.
  const evalError = (e: unknown, fallback: string) => {
    const msg = e instanceof Error ? e.message : String(e)
    if (/503|no openai key|not configured/i.test(msg)) {
      return 'OpenAI key not configured on this host — agent evals are unavailable.'
    }
    return msg || fallback
  }

  const runEnrichment = async () => {
    setError(null)
    setEnrichmentRunning(true)
    try {
      setEnrichmentResult(await adminApi.runEnrichmentEval())
    } catch (e) {
      setError(evalError(e, 'Failed to run enrichment eval'))
    } finally {
      setEnrichmentRunning(false)
    }
  }


  const runTutor = async () => {
    setError(null)
    setTutorRunning(true)
    try {
      setTutorResult(await adminApi.runTutorEval())
    } catch (e) {
      setError(evalError(e, 'Failed to run tutor eval'))
    } finally {
      setTutorRunning(false)
    }
  }

  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={judge} onChange={(e) => setJudge(e.target.value as 'ollama' | 'openai')} style={input} disabled={running}>
          <option value="ollama">Judge: Ollama (free)</option>
          <option value="openai">Judge: OpenAI (gpt-4.1)</option>
        </select>
        <button onClick={run} disabled={running} style={rangeBtn(false)}>
          {running ? 'Running…' : 'Run evals'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Runs all goldens through the real gateway and writes eval history.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={runCriticDefect} disabled={criticRunning} style={rangeBtn(false)}>
          {criticRunning ? 'Running…' : 'Run critic-defect eval'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Injects known defects into clean drafts, runs the real nano critic (~23 calls, 20–30s), gate ≥ 0.80 catch-rate.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={runCrewAb} disabled={crewAbRunning} style={rangeBtn(false)}>
          {crewAbRunning ? 'Running…' : 'Run crew A/B eval'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          A/B-tests the crew vs a single-call baseline over the goldens (~1–2 min), gate lift ≥ 10% and cost ratio ≤ 2×.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={runEnrichment} disabled={enrichmentRunning} style={rangeBtn(false)}>
          {enrichmentRunning ? 'Running…' : 'Run enrichment eval'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Runs the real EnrichmentAgent over ~30 goldens — calibration, honest-unknown, genre/year accuracy. This can take a minute.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={runTutor} disabled={tutorRunning} style={rangeBtn(false)}>
          {tutorRunning ? 'Running…' : 'Run tutor eval'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Runs the real TutorAgent over synthetic SRS states — due-coverage, weak-targeting, difficulty, thesis-alignment. This can take a minute.
        </span>
      </div>
      {criticResult && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>Critic-defect eval</span>
            <span style={{ fontWeight: 600, fontSize: 13, color: criticResult.passed ? '#059669' : '#dc2626' }}>
              {criticResult.passed ? 'PASS' : 'FAIL'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px 12px' }}>
            <Metric
              label="Catch rate"
              value={`${(criticResult.catchRate * 100).toFixed(1)}%`}
              color={criticResult.passed ? '#059669' : '#dc2626'}
            />
            <Metric label="False-positive rate" value={`${(criticResult.falsePositiveRate * 100).toFixed(1)}%`} />
            <Metric label="N" value={String(criticResult.n)} />
          </div>
        </div>
      )}
      {crewAbResult && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>Crew A/B eval</span>
            <span style={{ fontWeight: 600, fontSize: 13, color: crewAbResult.passed ? '#059669' : '#dc2626' }}>
              {crewAbResult.passed ? 'PASS' : 'FAIL'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px 12px' }}>
            <Metric
              label="Lift"
              value={`${(crewAbResult.liftPct * 100).toFixed(1)}%`}
              color={crewAbResult.passed ? '#059669' : '#dc2626'}
            />
            <Metric
              label="Cost ratio"
              value={`${crewAbResult.costRatio.toFixed(1)}×`}
              color={crewAbResult.costRatio > 2 ? '#dc2626' : undefined}
            />
            <Metric label="Avg A (baseline)" value={crewAbResult.avgA.toFixed(2)} />
            <Metric label="Avg B (crew)" value={crewAbResult.avgB.toFixed(2)} />
            <Metric label="Win rate" value={`${(crewAbResult.winRate * 100).toFixed(1)}%`} />
            <Metric label="N" value={String(crewAbResult.n)} />
          </div>
        </div>
      )}
      {enrichmentResult && (
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 15, color: '#111827', marginBottom: 12 }}>Enrichment eval</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px 12px' }}>
            <Metric label="Calibration" value={`${(enrichmentResult.calibration * 100).toFixed(1)}%`} color="#059669" />
            <Metric label="Honest-unknown" value={`${(enrichmentResult.honestUnknownRate * 100).toFixed(1)}%`} />
            <Metric label="Genre accuracy" value={`${(enrichmentResult.genreAccuracy * 100).toFixed(1)}%`} />
            <Metric label="Year accuracy" value={`${(enrichmentResult.yearAccuracy * 100).toFixed(1)}%`} />
            <Metric label="Avg tool calls" value={enrichmentResult.avgToolCalls.toFixed(2)} />
            <Metric label="N" value={String(enrichmentResult.n)} />
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Title</th>
                <th style={th}>Diff</th>
                <th style={th}>Conf</th>
                <th style={th}>Genre</th>
                <th style={th}>Year</th>
                <th style={th}>Unknown</th>
                <th style={th}>Tools</th>
              </tr>
            </thead>
            <tbody>
              {enrichmentResult.cases.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={td}>{c.title}</td>
                  <td style={td}>{c.difficulty}</td>
                  <td style={td}>{c.confidence.toFixed(2)}</td>
                  <td style={{ ...td, color: c.genreCorrect ? '#059669' : '#dc2626' }}>{c.genreCorrect ? '✓' : '✗'}</td>
                  <td style={{ ...td, color: c.yearCorrect ? '#059669' : '#dc2626' }}>{c.yearCorrect ? '✓' : '✗'}</td>
                  <td style={td}>{c.saidUnknown ? 'yes' : '—'}</td>
                  <td style={td}>{c.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tutorResult && (
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 15, color: '#111827', marginBottom: 12 }}>Tutor eval</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px 12px' }}>
            <Metric label="Due coverage" value={`${(tutorResult.dueCoverage * 100).toFixed(1)}%`} color="#059669" />
            <Metric label="Weak targeting" value={`${(tutorResult.weakTargeting * 100).toFixed(1)}%`} />
            <Metric label="Difficulty" value={`${(tutorResult.difficultyAppropriateness * 100).toFixed(1)}%`} />
            <Metric label="No-hallucination" value={`${(tutorResult.noHallucinationRate * 100).toFixed(1)}%`} />
            <Metric label="Thesis-aligned" value={`${(tutorResult.thesisAlignment * 100).toFixed(1)}%`} />
            <Metric label="Avg tool calls" value={tutorResult.avgToolCalls.toFixed(2)} />
            <Metric label="N" value={String(tutorResult.n)} />
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Case</th>
                <th style={th}>Planned</th>
                <th style={th}>Due</th>
                <th style={th}>Weak</th>
                <th style={th}>Diff</th>
                <th style={th}>No-halluc</th>
                <th style={th}>Thesis</th>
                <th style={th}>Tools</th>
              </tr>
            </thead>
            <tbody>
              {tutorResult.cases.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={td}>{c.name}</td>
                  <td style={td}>{c.planned}</td>
                  <td style={td}>{c.dueCoverage.toFixed(2)}</td>
                  <td style={td}>{c.weakTargeting.toFixed(2)}</td>
                  <td style={{ ...td, color: c.difficultyAppropriate ? '#059669' : '#dc2626' }}>{c.difficultyAppropriate ? '✓' : '✗'}</td>
                  <td style={{ ...td, color: c.noHallucination ? '#059669' : '#dc2626' }}>{c.noHallucination ? '✓' : '✗'}</td>
                  <td style={{ ...td, color: c.thesisAligned ? '#059669' : '#dc2626' }}>{c.thesisAligned ? '✓' : '✗'}</td>
                  <td style={td}>{c.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  // Group by feature (API returns newest-first), then flag regressions vs the next-older run.
  const byFeature = new Map<string, EvalRun[]>()
  for (const r of runs) {
    const arr = byFeature.get(r.feature) ?? []
    arr.push(r)
    byFeature.set(r.feature, arr)
  }

  return (
    <>
      {controls}
      {error && <Banner text={error} />}
      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="dashboard-empty">No eval runs yet. Click “Run evals” to populate (judge defaults to free local Ollama).</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {[...byFeature.entries()].map(([feature, fRuns]) => (
        <div key={feature}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{feature}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Score</th>
                <th style={th}>Breakdown</th>
                <th style={th}>Model</th>
                <th style={th}>Judge</th>
                <th style={th}>N</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {fRuns.map((r, i) => {
                const prev = fRuns[i + 1]
                const regressed = prev && r.score < prev.score - 0.1
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ ...td, fontWeight: 600, color: regressed ? '#dc2626' : '#111827' }}>
                      {r.score.toFixed(2)}
                      {regressed && <span title={`down from ${prev!.score.toFixed(2)}`}> ▼</span>}
                    </td>
                    <td style={td}>{formatBreakdown(r.breakdownJson)}</td>
                    <td style={td}>{r.modelId}</td>
                    <td style={td}>{r.judgeModelId}</td>
                    <td style={td}>{r.n}</td>
                    <td style={td}>{timeAgo(r.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
          ))}
        </div>
      )}
    </>
  )
}

// ─────────────────────────── Shadow ───────────────────────────

const SHADOW_PAGE = 25

function deltaColor(delta: number, lowerIsBetter: boolean): string {
  if (delta === 0) return '#6b7280'
  const good = lowerIsBetter ? delta < 0 : delta > 0
  return good ? '#059669' : '#dc2626'
}

function fmtDelta(delta: number, suffix: string): string {
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta}${suffix}`
}

function ShadowTab() {
  const [data, setData] = useState<ShadowSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  const [feature, setFeature] = useState('')
  const [selected, setSelected] = useState<ShadowPair | null>(null)

  useEffect(() => {
    setLoading(true)
    const from = new Date(Date.now() - days * 86400000).toISOString()
    adminApi
      .getShadowSummary({ from, feature: feature || undefined })
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [days, feature])

  // Feature options derived from the summary's pairs (distinct featureTags), not hardcoded.
  const featureOptions = [...new Set((data?.pairs ?? []).map((p) => p.featureTag))].sort()

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
            style={input}
          >
            <option value="">All features</option>
            {featureOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} style={rangeBtn(days === r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle" style={{ marginTop: 12 }}>Loading…</p>
      ) : !data || data.pairs.length === 0 ? (
        <p className="dashboard-empty" style={{ marginTop: 24 }}>
          No shadow runs in this window. Shadow routing is OFF by default — enable Ai:Shadow:Routes:&#123;feature&#125; + a
          sample rate to start comparing.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 24, margin: '16px 0' }}>
            <Totals label="Total shadow runs" value={data.totalRuns.toLocaleString()} />
            <Totals label="Pairs" value={String(data.pairs.length)} />
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Feature</th>
                <th style={th}>Primary</th>
                <th style={th}>Shadow</th>
                <th style={th}>Runs</th>
                <th style={th}>p50 latency (P / S / Δ)</th>
                <th style={th}>Cost (P / S / Δ)</th>
                <th style={th}>Proj. monthly Δ</th>
                <th style={th}>Exact-match</th>
                <th style={th}>Len ratio</th>
                <th style={th}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.pairs.map((p) => (
                <tr
                  key={`${p.featureTag}|${p.primaryModelId}|${p.shadowModelId}`}
                  onClick={() => setSelected(p)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                >
                  <td style={td}>{p.featureTag}</td>
                  <td style={td}>{p.primaryModelId}</td>
                  <td style={td}>{p.shadowModelId}</td>
                  <td style={td}>{p.runs.toLocaleString()}</td>
                  <td style={td}>
                    {p.primaryP50LatencyMs} / {p.shadowP50LatencyMs} ms{' '}
                    <span style={{ color: deltaColor(p.latencyDeltaMs, true), fontWeight: 600 }}>
                      {fmtDelta(p.latencyDeltaMs, 'ms')}
                    </span>
                  </td>
                  <td style={td}>
                    ${p.primaryCostUsd.toFixed(4)} / ${p.shadowCostUsd.toFixed(4)}{' '}
                    <span style={{ color: deltaColor(p.costDeltaUsd, true), fontWeight: 600 }}>
                      {p.costDeltaUsd >= 0 ? '+' : '-'}${Math.abs(p.costDeltaUsd).toFixed(4)}
                    </span>
                  </td>
                  <td style={{ ...td, color: deltaColor(p.projectedMonthlyCostDeltaUsd, true), fontWeight: 600 }}>
                    {p.projectedMonthlyCostDeltaUsd >= 0 ? '+' : '-'}${Math.abs(p.projectedMonthlyCostDeltaUsd).toFixed(2)}
                  </td>
                  <td style={td}>{(p.exactMatchRate * 100).toFixed(1)}%</td>
                  <td style={td}>{p.avgLengthRatio.toFixed(2)}×</td>
                  <td style={td}>{timeAgo(p.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
            Agreement = lexical (exact-match + length ratio), not a quality verdict. Semantic judge scoring lands in a later
            slice.
          </p>
        </>
      )}

      {selected && <ShadowSamplesModal pair={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

function ShadowSamplesModal({ pair, onClose }: { pair: ShadowPair; onClose: () => void }) {
  const [items, setItems] = useState<ShadowSample[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getShadowSamples({
        feature: pair.featureTag,
        primaryModelId: pair.primaryModelId,
        shadowModelId: pair.shadowModelId,
        limit: SHADOW_PAGE,
        offset,
      })
      .then((d) => {
        setItems(d.items)
        setTotal(d.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load samples'))
      .finally(() => setLoading(false))
  }, [pair, offset])

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{pair.featureTag} · shadow samples</h2>
          <button onClick={onClose} style={{ ...rangeBtn(false), border: 'none' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          primary <strong>{pair.primaryModelId}</strong> · shadow <strong>{pair.shadowModelId}</strong>
        </div>

        {error && <Banner text={error} />}

        {loading ? (
          <p className="dashboard-page__subtitle">Loading…</p>
        ) : items.length === 0 ? (
          <p className="dashboard-empty">No samples for this pair.</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {items.map((s) => (
                <div key={s.id} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{timeAgo(s.createdAt)}</span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        color: s.exactMatch ? '#059669' : '#d97706',
                      }}
                    >
                      {s.exactMatch ? 'exact match' : 'differs'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>
                        Primary · {s.primaryLatencyMs}ms · ${s.primaryCostUsd.toFixed(4)} · {s.primaryTokensOut} tok
                      </div>
                      <pre style={pre}>{s.primaryResponse ?? '—'}</pre>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 4 }}>
                        Shadow · {s.shadowLatencyMs}ms · ${s.shadowCostUsd.toFixed(4)} · {s.shadowTokensOut} tok
                      </div>
                      <pre style={pre}>{s.shadowResponse ?? '—'}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Pager offset={offset} total={total} onChange={setOffset} pageSize={SHADOW_PAGE} label="samples" />
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────── Models ───────────────────────────

function modelStatusColor(status: string): string {
  if (status === 'Primary') return '#059669'
  if (status === 'Shadow') return '#d97706'
  return '#6b7280' // Retired
}

// A pending confirm action: which row + what kind of mutation.
type ModelAction =
  | { kind: 'promote'; row: ModelRegistration }
  | { kind: 'rollback'; row: ModelRegistration }

function ModelsTab() {
  const [models, setModels] = useState<ModelRegistration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ModelAction | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = () =>
    adminApi
      .getModels()
      .then((d) => {
        setModels(d.models)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  // Features that currently have at least one Shadow row — rollback needs a prior promotion.
  const featuresWithShadow = new Set(models.filter((m) => m.status === 'Shadow').map((m) => m.featureTag))

  const runAction = async () => {
    if (!confirm) return
    setPending(true)
    setDialogError(null)
    try {
      let res: ModelPromotionResult
      if (confirm.kind === 'promote') {
        res = await adminApi.promoteModel(confirm.row.id)
      } else {
        res = await adminApi.rollbackModel(confirm.row.featureTag)
      }
      await load()
      setConfirm(null)
      setSuccess(
        `${res.action === 'Rollback' ? 'Rolled back' : 'Promoted'} ${res.featureTag} → primary ${res.newPrimary.modelId}` +
          (res.demotedToShadow ? ` (${res.demotedToShadow.modelId} now shadow)` : ''),
      )
    } catch (e) {
      // Surface the server message (409 race / 400 reasons) in the dialog; keep it open.
      setDialogError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <p className="dashboard-page__subtitle" style={{ margin: '0 0 12px' }}>
        Registered models per feature and their routing status. Promote a shadow to primary or roll a feature back to its
        previous primary.
      </p>

      {error && <Banner text={error} />}
      {success && <SuccessBanner text={success} onClose={() => setSuccess(null)} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : models.length === 0 ? (
        <p className="dashboard-empty">No models registered yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>Feature</th>
              <th style={th}>Provider</th>
              <th style={th}>Model</th>
              <th style={th}>Status</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={td}>{m.featureTag}</td>
                <td style={td}>{m.providerKey}</td>
                <td style={td}>{m.modelId}</td>
                <td style={{ ...td, fontWeight: 600, color: modelStatusColor(m.status) }}>{m.status}</td>
                <td style={td}>{timeAgo(m.createdAt)}</td>
                <td style={td}>
                  {m.status === 'Shadow' && (
                    <button
                      onClick={() => {
                        setDialogError(null)
                        setConfirm({ kind: 'promote', row: m })
                      }}
                      disabled={pending}
                      style={rangeBtn(false)}
                    >
                      Promote
                    </button>
                  )}
                  {m.status === 'Primary' && featuresWithShadow.has(m.featureTag) && (
                    <button
                      onClick={() => {
                        setDialogError(null)
                        setConfirm({ kind: 'rollback', row: m })
                      }}
                      disabled={pending}
                      style={rangeBtn(false)}
                    >
                      Rollback
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirm && (
        <ModelConfirmDialog
          action={confirm}
          pending={pending}
          error={dialogError}
          onConfirm={runAction}
          onClose={() => {
            if (!pending) setConfirm(null)
          }}
        />
      )}
    </>
  )
}

function ModelConfirmDialog({
  action,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  action: ModelAction
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const { row } = action
  const title = action.kind === 'promote' ? 'Promote to primary' : 'Roll back primary'
  const message =
    action.kind === 'promote'
      ? `Promote ${row.modelId} to primary for ${row.featureTag}? The current primary will keep running as shadow.`
      : `Roll back ${row.featureTag} to its previous primary?`
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, maxWidth: 460 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button onClick={onClose} disabled={pending} style={{ ...rangeBtn(false), border: 'none' }}>
            ✕
          </button>
        </div>
        <p style={{ fontSize: 14, color: '#374151', margin: '0 0 4px' }}>{message}</p>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>This changes production routing immediately.</p>
        {error && <Banner text={error} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} disabled={pending} style={rangeBtn(false)}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={pending} style={rangeBtn(true)}>
            {pending ? 'Working…' : action.kind === 'promote' ? 'Promote' : 'Roll back'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── Drift ───────────────────────────

const DRIFT_THRESHOLD = 0.15

function driftStateColor(state: DriftAlertState): string {
  if (state === 'alerting') return '#dc2626' // red
  if (state === 'warning') return '#d97706' // amber
  if (state === 'ok') return '#059669' // green
  return '#9ca3af' // baseline / insufficient — grey/muted
}

function DriftBadge({ state }: { state: DriftAlertState }) {
  const color = driftStateColor(state)
  const muted = state === 'baseline' || state === 'insufficient'
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        color: muted ? '#6b7280' : '#fff',
        background: muted ? '#f3f4f6' : color,
        border: muted ? '1px solid #e5e7eb' : 'none',
        borderRadius: 4,
        padding: '2px 8px',
      }}
    >
      {state}
    </span>
  )
}

// Inline drift-over-time line, daily driftScore vs the 0.15 alert threshold.
function DriftChart({ points }: { points: DriftPoint[] }) {
  const w = 640
  const h = 120
  const padX = 8
  const padY = 8
  const scored = points.filter((p) => p.driftScore != null)
  if (scored.length < 2) {
    return (
      <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0 16px' }}>
        Not enough scored days to chart yet (need ≥ 2). See the table below.
      </p>
    )
  }
  const vals = scored.map((p) => p.driftScore as number)
  const maxVal = Math.max(...vals, DRIFT_THRESHOLD * 1.2)
  const minVal = 0
  const range = maxVal - minVal || 1
  const step = points.length > 1 ? (w - padX * 2) / (points.length - 1) : 0
  const y = (v: number) => h - padY - ((v - minVal) / range) * (h - padY * 2)
  const x = (i: number) => padX + i * step
  const thresholdY = y(DRIFT_THRESHOLD)

  // Build the polyline only over days that have a score (skip nulls in coords).
  const coords = points
    .map((p, i) => (p.driftScore == null ? null : `${x(i).toFixed(1)},${y(p.driftScore).toFixed(1)}`))
    .filter((c): c is string => c != null)
    .join(' ')

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ margin: '8px 0 16px' }}>
      {/* threshold line at 0.15 — the alert line, bold red dashed */}
      <line x1={padX} y1={thresholdY} x2={w - padX} y2={thresholdY} stroke="#dc2626" strokeWidth="1.5" strokeDasharray="5 4" />
      <polyline points={coords} fill="none" stroke="#2563eb" strokeWidth="2" />
      {points.map((p, i) =>
        p.driftScore == null ? null : (
          <circle
            key={p.day}
            cx={x(i)}
            cy={y(p.driftScore)}
            r={p.alertState === 'alerting' ? 4 : 3}
            fill={driftStateColor(p.alertState)}
          >
            <title>{`${p.day}: ${p.driftScore.toFixed(3)} (${p.alertState}, n=${p.sampleSize})`}</title>
          </circle>
        ),
      )}
    </svg>
  )
}

function DriftTab() {
  const [points, setPoints] = useState<DriftPoint[]>([])
  const [feature, setFeature] = useState('')
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getDrift({ feature: feature || undefined, days })
      .then((d) => {
        setPoints(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [feature, days])

  // Feature options: union of KNOWN_FEATURES and any features in the response.
  const featureOptions = [...new Set([...KNOWN_FEATURES, ...points.map((p) => p.feature)])].sort()
  const alertingDays = points.filter((p) => p.alertState === 'alerting').length

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={feature} onChange={(e) => setFeature(e.target.value)} style={input}>
            <option value="">All features</option>
            {featureOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} style={rangeBtn(days === r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <p className="dashboard-page__subtitle" style={{ margin: '12px 0 0' }}>
        Daily output-drift score per feature vs a 0.15 alert threshold. Higher = more divergence from the rolling baseline.
      </p>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle" style={{ marginTop: 12 }}>Loading…</p>
      ) : points.length === 0 ? (
        <p className="dashboard-empty" style={{ marginTop: 24 }}>
          Drift detection is OFF by default — enable Drift:Enabled to start sampling.
        </p>
      ) : (
        <>
          {alertingDays > 0 && (
            <div
              style={{
                background: '#fef2f2',
                color: '#b91c1c',
                padding: '8px 12px',
                borderRadius: 8,
                margin: '12px 0',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              ⚠ {alertingDays} day{alertingDays === 1 ? '' : 's'} over the 0.15 drift threshold.
            </div>
          )}
          <DriftChart points={points} />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Day</th>
                {feature === '' && <th style={th}>Feature</th>}
                <th style={th}>Drift score</th>
                <th style={th}>Sample size</th>
                <th style={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => {
                const over = p.driftScore != null && p.driftScore >= DRIFT_THRESHOLD
                return (
                  <tr
                    key={`${p.feature}|${p.day}`}
                    style={{ borderBottom: '1px solid #f3f4f6', background: p.alertState === 'alerting' ? '#fef2f2' : undefined }}
                  >
                    <td style={td}>{p.day}</td>
                    {feature === '' && <td style={td}>{p.feature}</td>}
                    <td style={{ ...td, fontWeight: 600, color: over ? '#dc2626' : '#111827' }}>
                      {p.driftScore != null ? p.driftScore.toFixed(3) : '—'}
                      {over && <span> ▲</span>}
                    </td>
                    <td style={td}>{p.sampleSize}</td>
                    <td style={td}>
                      <DriftBadge state={p.alertState} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      <DriftEvalTrend feature={feature} />
    </>
  )
}

function DriftEvalTrend({ feature }: { feature: string }) {
  const [points, setPoints] = useState<ScheduledEvalPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    adminApi
      .getEvalTrend({ feature: feature || undefined })
      .then((d) => {
        setPoints(d)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [feature])

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Scheduled eval trend</h2>
      <p className="dashboard-page__subtitle" style={{ margin: '0 0 12px' }}>
        Latest scheduled eval scores (1–5) over time — the quality signal drift is meant to catch early.
      </p>

      {error && <Banner text={error} />}

      {loading ? (
        <p className="dashboard-page__subtitle">Loading…</p>
      ) : points.length === 0 ? (
        <p className="dashboard-empty">No scheduled eval runs yet — enable Eval:Scheduled:Enabled.</p>
      ) : (
        <>
          <EvalSparkline points={points} />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>When</th>
                {feature === '' && <th style={th}>Feature</th>}
                <th style={th}>Score</th>
                <th style={th}>Model</th>
                <th style={th}>N</th>
                <th style={th}>Git SHA</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const prev = points[i + 1]
                const regressed = prev && prev.feature === p.feature && p.score < prev.score - 0.1
                return (
                  <tr key={`${p.feature}|${p.createdAt}|${i}`} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={td}>{timeAgo(p.createdAt)}</td>
                    {feature === '' && <td style={td}>{p.feature}</td>}
                    <td style={{ ...td, fontWeight: 600, color: regressed ? '#dc2626' : '#111827' }}>
                      {p.score.toFixed(2)}
                      {regressed && <span title={`down from ${prev!.score.toFixed(2)}`}> ▼</span>}
                    </td>
                    <td style={td}>{p.modelId}</td>
                    <td style={td}>{p.n}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>
                      {p.gitSha ? p.gitSha.slice(0, 7) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// Eval score sparkline (1–5). API returns newest-first, so render reversed (oldest → newest).
function EvalSparkline({ points }: { points: ScheduledEvalPoint[] }) {
  const w = 640
  const h = 80
  const pad = 6
  const ordered = [...points].reverse()
  if (ordered.length < 2) return null
  const min = 1
  const max = 5
  const range = max - min
  const step = (w - pad * 2) / (ordered.length - 1)
  const y = (v: number) => h - pad - ((Math.min(max, Math.max(min, v)) - min) / range) * (h - pad * 2)
  const coords = ordered.map((p, i) => `${(pad + i * step).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ margin: '4px 0 12px' }}>
      <polyline points={coords} fill="none" stroke="#7c3aed" strokeWidth="2" />
      {ordered.map((p, i) => (
        <circle key={`${p.createdAt}|${i}`} cx={pad + i * step} cy={y(p.score)} r={3} fill="#7c3aed">
          <title>{`${p.score.toFixed(2)} · ${p.feature} · ${new Date(p.createdAt).toLocaleString()}`}</title>
        </circle>
      ))}
    </svg>
  )
}

// ─────────────────────────── shared ───────────────────────────

function Pager({
  offset,
  total,
  onChange,
  pageSize = PAGE,
  label = 'traces',
}: {
  offset: number
  total: number
  onChange: (o: number) => void
  pageSize?: number
  label?: string
}) {
  const page = Math.floor(offset / pageSize) + 1
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 13, color: '#6b7280' }}>
      <button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))} style={rangeBtn(false)}>
        ← Prev
      </button>
      <span>
        Page {page} / {pages} · {total} {label}
      </span>
      <button disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)} style={rangeBtn(false)}>
        Next →
      </button>
    </div>
  )
}

function Banner({ text }: { text: string }) {
  return <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 12, borderRadius: 8, margin: '12px 0' }}>{text}</div>
}

function SuccessBanner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div
      style={{
        background: '#ecfdf5', color: '#065f46', padding: 12, borderRadius: 8, margin: '12px 0',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      }}
    >
      <span>{text}</span>
      <button onClick={onClose} style={{ border: 'none', background: 'none', color: '#065f46', cursor: 'pointer', fontSize: 14 }}>
        ✕
      </button>
    </div>
  )
}

function formatBreakdown(json: string | null): string {
  if (!json) return '—'
  try {
    const obj = JSON.parse(json) as Record<string, number>
    return Object.entries(obj)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')
  } catch {
    return json
  }
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const card: CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, background: '#fff' }
const input: CSSProperties = { padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }
const th: CSSProperties = { padding: '8px 10px', fontWeight: 600 }
const td: CSSProperties = { padding: '8px 10px' }
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
  alignItems: 'flex-start', justifyContent: 'center', padding: 40, zIndex: 50, overflow: 'auto',
}
const modal: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 760, width: '100%' }
const pre: CSSProperties = {
  background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 10,
  fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflow: 'auto', margin: 0,
}

function rangeBtn(active: boolean): CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db',
    background: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#374151',
    cursor: 'pointer', fontSize: 13,
  }
}
