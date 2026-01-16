# PDD: Observability via OpenTelemetry

## Status
Implemented

## Goal
Production-grade observability for API + Worker using OpenTelemetry:
- Distributed tracing (TraceId correlation)
- Metrics (durations, counts, failures, OCR usage)
- Structured logs correlated to TraceId
- Dashboards + alerting via Grafana

Answer questions like: "What failed?", "Where is time spent?", "How often does OCR run?", "Which formats fail most?"

## Non-goals
- Advanced anomaly detection
- PII in attributes/logs
- Pager integrations (Slack/PagerDuty) — future work

## Slices

### Slice 7: Core OpenTelemetry Setup (Done)
- Add OTel packages to API + Worker
- Configure Resource attributes (service.name, version, environment)
- OTLP exporter (env-based config)
- Tracing instrumentation:
  - API: AspNetCore + HttpClient
  - Worker: ingestion pipeline spans
- Metrics: counters, histograms for ingestion
- Log correlation with TraceId
- otel-collector in docker-compose

### Slice 8: Dashboards + Alerting + SLOs (Done)
- Extend docker-compose: Prometheus, Grafana, Tempo
- Collector config for Prometheus + Tempo export
- Queue metrics (pending, lag)
- SLO definitions
- Grafana dashboards:
  - Ingestion Overview
  - Extraction Performance
  - Worker Health
- Alert rules (failure rate, latency, backlog)

### Slice 9: Operational Hardening (Future)
- Log retention policies
- Sampling strategy
- Cardinality control
- Cost/perf tuning

## Metrics Emitted

### Counters
- `onlinelib_ingestion_jobs_started_total{format}`
- `onlinelib_ingestion_jobs_succeeded_total{format}`
- `onlinelib_ingestion_jobs_failed_total{format, reason}`
- `onlinelib_extraction_ocr_used_total{format}`

### Histograms
- `onlinelib_ingestion_job_duration_ms{format}`
- `onlinelib_extraction_duration_ms{format, text_source}`

### Gauges
- `onlinelib_ingestion_jobs_in_progress`
- `onlinelib_ingestion_jobs_pending`
- `onlinelib_ingestion_queue_lag_ms`

## Traces

Key spans in Worker pipeline:
- `ingestion.job.pick`
- `ingestion.job.process`
- `ingestion.file.open`
- `extraction.run`
- `persist.result`

## SLOs

| SLO | Target |
|-----|--------|
| Ingestion success rate | >= 98% (24h) |
| Extraction p95 latency | <= 60s |
| Queue lag | < 1h |

See [observability/slo.md](/observability/slo.md) for details.

## Local Stack

| Service | Port | URL |
|---------|------|-----|
| Grafana | 3000 | http://localhost:3000 |
| Prometheus | 9090 | http://localhost:9090 |

> **Note**: Tempo (distributed tracing) was removed in Jan 2026 to reduce memory usage (~350MB). Traces are still collected but not stored.

## Files

- `backend/src/Infrastructure/Telemetry/` — ActivitySource, Meter, extensions
- `infra/otel/otel-collector-config.yaml` — Collector config
- `observability/` — Grafana dashboards, Prometheus config, Loki config, SLO docs

## Acceptance Criteria
- API and Worker emit traces and metrics via OTLP
- Worker spans show ingestion pipeline stages
- Metrics show counts + durations by format
- Logs correlate with TraceId/SpanId
- docker-compose includes collector + Prometheus + Grafana + Loki
- Dashboards and alerts are provisioned
