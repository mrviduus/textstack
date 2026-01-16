# Service Level Objectives (SLOs)

## Ingestion Pipeline SLOs

### SLO 1: Ingestion Success Rate
**Target**: >= 98% success rate over 24h for supported formats

**Metrics**:
- `onlinelib_ingestion_jobs_succeeded_total{format}`
- `onlinelib_ingestion_jobs_failed_total{format, reason}`

**PromQL**:
```promql
# Success rate by format (24h window)
sum(rate(onlinelib_ingestion_jobs_succeeded_total[24h])) by (format)
/
(sum(rate(onlinelib_ingestion_jobs_succeeded_total[24h])) by (format) + sum(rate(onlinelib_ingestion_jobs_failed_total[24h])) by (format))

# Overall success rate
sum(rate(onlinelib_ingestion_jobs_succeeded_total[24h]))
/
(sum(rate(onlinelib_ingestion_jobs_succeeded_total[24h])) + sum(rate(onlinelib_ingestion_jobs_failed_total[24h])))
```

**Exclusions**:
- Jobs failed due to `unsupported` format are excluded from SLO calculations
- Only `parse_error`, `file_not_found`, `no_text_layer` count as SLO violations

---

### SLO 2: Extraction Latency (p95)
**Target**: p95 extraction duration <= thresholds by format

| Format | p95 Target |
|--------|------------|
| Epub   | 5s         |
| Pdf    | 30s        |
| Txt/Md | 1s         |

**Metrics**:
- `onlinelib_extraction_duration_ms{format, text_source}`

**PromQL**:
```promql
# p95 extraction duration by format
histogram_quantile(0.95, sum(rate(onlinelib_extraction_duration_ms_bucket[15m])) by (le, format))
```

---

### SLO 3: Queue Backlog / Throughput
**Target**:
- Pending jobs < 100 sustained
- Queue lag (oldest job age) < 1h

**Metrics**:
- `onlinelib_ingestion_jobs_pending`
- `onlinelib_ingestion_queue_lag_ms`

**PromQL**:
```promql
# Pending jobs count
onlinelib_ingestion_jobs_pending

# Queue lag in minutes
onlinelib_ingestion_queue_lag_ms / 1000 / 60
```

---

## Failure Reason Classification

| Reason          | Description                              | SLO Impact |
|-----------------|------------------------------------------|------------|
| `parse_error`   | Failed to parse file contents            | Yes        |
| `file_not_found`| Source file missing from storage         | Yes        |
| `no_text_layer` | PDF has no extractable text              | Yes        |
| `unsupported`   | Format not supported                     | No         |
| `ocr_failed`    | OCR extraction failed                    | Yes        |

---

## Alert Thresholds

| Alert                    | Condition                                      | Severity |
|--------------------------|------------------------------------------------|----------|
| High Failure Rate        | failure_rate > 5% for 15m                      | Warning  |
| Critical Failure Rate    | failure_rate > 10% for 15m                     | Critical |
| Extraction Latency       | p95 > 2x target for 15m                        | Warning  |
| Backlog Growing          | pending > 100 for 30m                          | Warning  |
| Queue Stale              | queue_lag > 1h for 30m                         | Critical |
| OCR Spike                | OCR rate > 50% of jobs for 15m                 | Info     |

---

## Dashboard Links

- [Ingestion Overview](/d/ingestion-overview)
- [Extraction Performance](/d/extraction-performance)
- [Worker Health](/d/worker-health)
