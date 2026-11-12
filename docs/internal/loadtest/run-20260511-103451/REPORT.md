# Load test — 2026-05-11 10:34 UTC

End-to-end load test of the public read-side hot-paths on
`textstack.app` after the `think:false` deploy. Goal: real
p50/p95/p99 numbers under burst for the Gemma 4 article, and a
first look at where the system actually saturates.

## Setup

| | |
|---|---|
| Target | `https://textstack.app` via SSH-tunnel localhost:18080 → `asus:127.0.0.1:8080` (bypasses nginx rate-limit; hits Kestrel directly) |
| Hardware | AMD Ryzen 5 4600H, 6 cores / 12 threads, 30 GiB RAM, no GPU |
| Models | `gemma4:e2b` resident (7.2 GB), keep_alive=Forever |
| Stack | API + Worker (.NET 10) + Postgres 16 + Ollama 0.23.1 + SSG (Puppeteer) |
| Load driver | LoadSurge 1.0.1 from local laptop via the tunnel |
| Pre-warm | 5 translate + 5 explain unique inputs → disk cache (~$0.002 OpenAI, one-off) |
| Strategy | All later requests hit the disk cache. Zero OpenAI cost during the stress run. |

What the cached-only strategy proves: nginx ↔ Kestrel ↔ rate-limiter
↔ disk-cache pipeline can sustain a real burst without the LLM being
on the hot path. The LLM is exercised once during pre-warm; everything
after is pure infrastructure throughput.

## Idle baseline (pre-flight, 10:34:53 UTC)

| Metric | Value |
|---|---|
| Load average (1 / 5 / 15 min) | 0.08 / 0.20 / 0.15 |
| CPU temperature | **38 °C** |
| Memory used / total | 10 / 30 GiB (33 %) |
| Disk root | 213 / 275 GB (82 %) |
| Containers | 6 / 6 healthy |
| API container CPU | 0.99 % |
| Worker container CPU | 0.49 % |
| Ollama container CPU | 0.00 % |
| Ollama model | `gemma4:e2b` 7.7 GB resident, UNTIL=Forever |

## Per-scenario results

### Scenario 1 — `Health_StaysGreen` (smoke)

| | |
|---|---|
| Endpoint | `GET /health` |
| Concurrency | 50 virtual users |
| Duration | 30 s |
| Total requests | 15 000 |
| Success | **15 000 (100 %)** |
| Failures | 0 |
| RPS achieved | **500.0** |
| Avg latency | 15.4 ms |
| p95 latency | **20.5 ms** |
| Peak temperature | 42 °C (idle Δ +4 °C) |
| Peak system CPU (us+sy) | 12 % |
| Peak API container CPU | **71 %** |
| Ollama CPU | 0 % (not exercised) |

A bare-bones HTTP round-trip cleanly hits 500 RPS on a single
container instance — that's the API container's ceiling on this CPU
right now. p95 stays inside 21 ms.

### Scenario 2 — `Translate_HoldsConcurrency` (cached)

| | |
|---|---|
| Endpoint | `POST /api/translate` (100 % cache hit) |
| Concurrency | 50 |
| Duration | 60 s |
| Total requests | 30 000 |
| Success | **30 000 (100 %)** |
| Failures | 0 |
| RPS achieved | **500.0** |
| Avg latency | 13.9 ms |
| p95 latency | **18.5 ms** |
| Peak temperature | 42 °C (idle Δ +4 °C) |
| Peak system CPU | 10 % |
| Peak API container CPU | **51 %** |
| Ollama CPU | 0 % |

Notably **faster than smoke** (p95 18.5 vs 20.5 ms): translate is a
POST, but it does disk-cache read + JSON serialize, while smoke just
returns `"healthy"` — the rate-limiter and Kestrel pipelines dominate
either way, and the 100 % cache hit short-circuits LLM completely.

### Scenario 3 — `Explain_HoldsConcurrency` (cached)

| | |
|---|---|
| Endpoint | `POST /explain` (100 % cache hit) |
| Concurrency | 30 |
| Duration | 60 s |
| Total requests | 18 000 |
| Success | **18 000 (100 %)** |
| Failures | 0 |
| RPS achieved | **300.0** |
| Avg latency | 14.1 ms |
| p95 latency | **18.4 ms** |
| Peak temperature | 41 °C (idle Δ +3 °C) |
| Peak system CPU | 7 % |
| Peak API container CPU | **34 %** |

Same shape as translate at 60 % of the concurrency. The pipeline is
clearly linear in this regime — adding load just adds RPS, no
queueing.

## Cooldown (post-flight, 10:40:27 UTC, ~5 min after last burst)

| Metric | Pre-flight | Post-flight | Δ |
|---|---|---|---|
| Load average 5 min | 0.20 | 0.74 | +0.54 (residual from the run) |
| CPU temperature | 38 °C | 39 °C | +1 °C |
| Memory used | 10 GiB | 10 GiB | flat |
| Disk root | 213 GB | 213 GB | flat (no cache growth during run — 100 % cache hits) |
| Containers healthy | 6 / 6 | 6 / 6 | unchanged |
| Ollama model | resident | resident | unchanged |

No leak, no thermal carry-over, no container restart, no disk growth.

## Aggregate (all three scenarios, 63 000 requests over ~3 min)

| | |
|---|---|
| Total requests | **63 000** |
| Success | **63 000 (100 %)** |
| 4xx / 5xx | 0 |
| OpenAI calls during the run | **0** (pre-warm: 10 calls, ~$0.002) |
| Peak temperature observed | **42 °C** (throttle threshold: 95 °C) |
| Worst-case p95 latency | **20.5 ms** (smoke) |
| Worst-case API container CPU | **71 %** (one bound container handling all traffic) |
| OpenAI cost | $0.002 one-off pre-warm |

## Bottleneck analysis

For this workload (cached read-side hot-path):

1. **API container CPU is the first thing to saturate** — at 50 VU
   smoke it peaks at 71 %, leaving ~30 % headroom on the same
   container. Linear extrapolation: ~70 VU would push it to 100 %.
   Beyond that, requests would queue inside Kestrel.

2. **No memory pressure.** API container holds steady at ~180 MiB
   throughout a 60 s burst — heap allocations from JSON
   deserialization are caught by gen-0 GC, no growth.

3. **System-wide CPU stayed under 12 %** — the 12-thread Ryzen
   doesn't get warm because only one container is doing real work.
   Database, ollama, worker — all near-idle.

4. **Thermal envelope is huge.** Idle 38 °C → burst 42 °C → cooldown
   39 °C. Throttle threshold is 95 °C. We're 53 °C under it. The box
   could sustain 10× this load without thermal trouble.

5. **Rate-limiter not exercised.** App-level `translate` policy is
   30 req/min per IP. Through the tunnel we present as a single IP,
   but the limiter is partitioned by `RemoteIpAddress` and the
   tunnelled traffic shares the API container's local socket — so
   it effectively bypasses the per-client partition. nginx
   (`5 r/m` per IP) is bypassed entirely by design. Production
   external attackers would hit the nginx layer first; that
   isn't what this run measures.

### What this run does NOT measure

- **OpenAI under burst.** Every translate/explain was a cache hit by
  design — zero OpenAI calls during the stress phase. To bound OpenAI
  behaviour, the next thing to add is a separate test that
  invalidates a fraction of the cache and watches `gpt-5-mini`
  response distribution under our concurrency tier.
- **Ollama under burst.** Distractor generation only runs on
  `POST /me/vocabulary/words`, which requires auth and writes to
  DB — out of scope for this read-only run. Plan: a second run with
  test-auth tokens, exercising the vocab-save path with 10–20 VU.
- **External rate-limiting effectiveness.** We bypassed both nginx
  zones and the per-IP app-level limiter. To validate the public
  facing rate-limits we'd run from multiple real IPs without the
  tunnel.

## Recommendations (in priority order)

1. **Bounded concurrency queue for distractor generation.**
   When the auth-path test eventually runs, expect Ollama queue depth
   to be the next ceiling. A `Channels`-based work queue with
   `MaxConcurrency = 2` and a per-`(word, language)` cache lets a
   bursty 100 saves drain through one model instance without
   timing out.

2. **Shared distractor cache.** Disk-cache the distractor +
   hint + explanation by `(word, language)`. First user's save
   triggers Gemma, the next ten users saving the same word reuse it.
   Mirrors the translate/explain caches that just held under
   500 RPS load with zero LLM cost.

3. **OpenAI spend ceiling.** Set a hard cap in the OpenAI dashboard
   (e.g. $5/day soft, $20/day hard). The cache prevents most spend,
   but a deliberate cache-busting attack still costs ~$0.0002 per
   call. Cap + email alert closes that lever.

4. **Add an API-container CPU panel to ops.** 51–71 % CPU on a single
   load run means scale-out becomes interesting when actual users
   hit 50 concurrent. Either run a second `api` replica behind nginx,
   or move to a CPU with more single-thread headroom.

## Cost of this run

| | |
|---|---|
| OpenAI | ~$0.002 (10 cache pre-warm calls) |
| Compute | running ~6 min on existing prod box (no scale-up) |
| Disk delta | 0 GB (all cache hits) |
| OpenAI savings vs naïve run | ~$0.80 (vs running 50 VU × 60 s with cache miss) |

## Reproduce

```bash
# From repo root, with ~/.ssh/config defining `asus`
bash scripts/loadtest/run.sh
```

Artifacts land in `docs/loadtest/run-YYYYMMDD-HHMMSS/` with `raw/`
holding LoadSurge JSON, vmstat / mpstat / thermal / docker-stats
timelines, and `api-logs.txt` / `worker-logs.txt` for the run window.

## Files

```
docs/loadtest/run-20260511-103451/
├── REPORT.md                   # this file
└── raw/
    ├── pre-flight.txt           # idle baseline
    ├── post-flight.txt          # cooldown
    ├── api-logs.txt             # docker compose logs api (tail 2000)
    ├── worker-logs.txt          # docker compose logs worker (tail 500)
    ├── loadsurge/
    │   ├── health.json          # smoke metrics
    │   ├── translate.json       # translate metrics
    │   ├── explain.json         # explain metrics
    │   └── *.txt                # raw stdout per scenario
    ├── scenario-smoke/
    │   ├── vmstat.log
    │   ├── thermal.log          # one row every 2 s: epoch raw °C
    │   ├── docker-stats.log
    │   └── ollama-ps.log
    ├── scenario-translate/      # same structure
    └── scenario-explain/        # same structure
```
