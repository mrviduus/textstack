# PDD: Observability via OpenTelemetry

## Status
Implemented

## Goal
Production-grade observability for API + Worker using OpenTelemetry:
- Distributed tracing (TraceId correlation)
- Metrics (durations, counts, failures, OCR usage)
- Structured logs correlated to TraceId

Answer questions like: "What failed?", "Where is time spent?", "How often does OCR run?", "Which formats fail most?"

## Architecture

```
API/Worker → OTLP → Aspire Dashboard (traces, logs, metrics)
```

**Note**: Replaced Grafana + Prometheus + Loki + OTel Collector with single Aspire Dashboard in Jan 2026 for simplicity.

## Non-goals
- Advanced anomaly detection
- PII in attributes/logs
- Alerting (not supported by Aspire Dashboard)
- Long-term metrics retention (Aspire Dashboard is session-only)

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

## Local Stack

| Service | Port | URL |
|---------|------|-----|
| Aspire Dashboard | 18888 | http://localhost:18888 |

Dashboard provides:
- **Traces** tab: distributed traces
- **Structured Logs** tab: logs with TraceId correlation
- **Metrics** tab: custom metrics

## Files

- `backend/src/Infrastructure/Telemetry/` — ActivitySource, Meter, extensions

## Limitations (Aspire Dashboard vs Grafana/Prometheus)

| Feature | Before | After |
|---------|--------|-------|
| Metrics retention | 30 days | Session only |
| Alerting | 6 rules | None |
| Custom dashboards | Yes | Built-in views |
| Log aggregation | 30 days | Session only |

## Acceptance Criteria
- API and Worker emit traces and metrics via OTLP
- Worker spans show ingestion pipeline stages
- Metrics show counts + durations by format
- Logs correlate with TraceId/SpanId
- docker-compose includes Aspire Dashboard
