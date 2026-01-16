# Observability Stack

OpenTelemetry-based observability for TextStack (OnlineLib). Metrics and logs monitoring.

## Architecture Overview

```
┌─────────────┐     ┌─────────────┐
│   API       │     │   Worker    │
│ (ASP.NET)   │     │ (ASP.NET)   │
└──────┬──────┘     └──────┬──────┘
       │ OTLP              │ OTLP
       │ (gRPC:4317)       │
       └─────────┬─────────┘
                 ▼
       ┌─────────────────┐
       │ OTEL Collector  │
       └────┬───────┬────┘
            │       │
     ┌──────┘       └──────┐
     ▼                     ▼
┌─────────┐           ┌─────────┐
│Prometheus│           │  Loki   │
│(Metrics) │           │ (Logs)  │
└────┬─────┘           └────┬────┘
     │                      │
     └──────────┬───────────┘
                ▼
          ┌──────────┐
          │ Grafana  │
          │  :3000   │
          └──────────┘
```

## Stack Components

| Component       | Port  | URL                      | Purpose                |
|-----------------|-------|--------------------------|------------------------|
| Grafana         | 3000  | http://localhost:3000    | Visualization & alerts |
| Prometheus      | 9090  | http://localhost:9090    | Metrics storage        |
| Loki            | 3100  | http://localhost:3100    | Log aggregation        |
| OTEL Collector  | 4317  | gRPC                     | Telemetry routing      |
| OTEL Collector  | 4318  | HTTP                     | Telemetry routing      |

## Quick Start

```bash
# Development
docker compose up -d

# Production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# View Grafana
open http://localhost:3000
# Login: admin / <your-password>
```

---

## Logs (Loki)

### Accessing Logs

1. Open **Grafana** → **Explore** (compass icon in left sidebar)
2. Select **Loki** from the datasource dropdown (top)
3. Switch to **Code** mode (top right toggle)

### Basic LogQL Queries

```logql
# All logs from API
{service_name="onlinelib-api"}

# All logs from Worker
{service_name="onlinelib-worker"}

# Filter by log level
{service_name="onlinelib-api"} | json | level="Error"
{service_name="onlinelib-worker"} | json | level="Warning"

# Search for specific text
{service_name="onlinelib-api"} |= "Exception"
{service_name="onlinelib-worker"} |= "ingestion"

# Exclude noisy logs
{service_name="onlinelib-api"} != "healthcheck"

# Regex search
{service_name="onlinelib-api"} |~ "book.*failed"

# Parse JSON and filter
{service_name="onlinelib-worker"} | json | attributes_commandText=~".*ingestion_jobs.*"
```

### What to Look For in Logs

| Pattern | Meaning | Action |
|---------|---------|--------|
| `level="Error"` | Application errors | Investigate immediately |
| `level="Warning"` | Potential issues | Monitor for patterns |
| `Exception` | Unhandled exceptions | Check stack trace |
| `timeout` | Operation timeouts | Check resource limits |
| `connection refused` | Service unavailable | Check dependent services |
| `OOM` or `memory` | Memory issues | Increase limits |

---

## Metrics (Prometheus)

### Accessing Metrics

1. **Grafana Dashboards** - Pre-built visualizations
2. **Grafana Explore** → **Prometheus** - Ad-hoc queries
3. **Prometheus UI** - http://localhost:9090/graph

### Key Metrics

#### Ingestion Counters
```promql
# Jobs started per minute
rate(onlinelib_ingestion_jobs_started_total[5m])

# Success rate
sum(rate(onlinelib_ingestion_jobs_succeeded_total[5m])) /
sum(rate(onlinelib_ingestion_jobs_started_total[5m]))

# Failures by reason
sum by (reason) (rate(onlinelib_ingestion_jobs_failed_total[5m]))
```

#### Queue Health
```promql
# Current queue depth
onlinelib_ingestion_jobs_pending

# Jobs in progress
onlinelib_ingestion_jobs_in_progress

# Queue lag (oldest job age)
onlinelib_ingestion_queue_lag_ms_milliseconds
```

#### Performance
```promql
# p95 extraction duration
histogram_quantile(0.95, rate(onlinelib_extraction_duration_ms_bucket[5m]))

# Average job duration by format
avg by (format) (rate(onlinelib_ingestion_job_duration_ms_sum[5m]) /
                 rate(onlinelib_ingestion_job_duration_ms_count[5m]))
```

#### Runtime Metrics
```promql
# Memory usage
onlinelib_dotnet_process_memory_working_set_bytes

# GC collections
rate(onlinelib_dotnet_gc_collections_total[5m])

# Thread pool queue
onlinelib_dotnet_thread_pool_queue_length_total
```

---

## Dashboards

### Pre-provisioned Dashboards

Access via **Grafana** → **Dashboards** → **Browse**

#### 1. Ingestion Overview
- **Purpose**: High-level health of book processing
- **Key panels**:
  - Jobs started/succeeded/failed over time
  - Success rate percentage
  - Failure reasons breakdown
  - OCR usage rate
- **When to use**: Daily monitoring, incident response

#### 2. Extraction Performance
- **Purpose**: Deep-dive into processing times
- **Key panels**:
  - p50/p95/p99 latency by format
  - Slow extraction traces
  - Format distribution
- **When to use**: Performance optimization, SLA monitoring

#### 3. Worker Health
- **Purpose**: Worker process health
- **Key panels**:
  - Queue depth and backlog
  - Processing throughput
  - Memory and CPU usage
  - Active workers
- **When to use**: Capacity planning, scaling decisions

### Reading Dashboards

1. **Time range** (top right): Adjust to relevant period
2. **Refresh** (top right): Set auto-refresh for live monitoring
3. **Panel drill-down**: Click panel title → Explore for deeper analysis
4. **Variables** (top): Filter by service, format, etc.

---

## Alerts

### Provisioned Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Failure Rate | >5% failures for 15m | Warning | Check logs for errors |
| Critical Failure Rate | >10% failures for 15m | Critical | Immediate investigation |
| High Extraction Latency | p95 >60s for 15m | Warning | Check resource usage |
| Backlog Growing | >100 pending for 30m | Warning | Scale workers |
| Queue Stale | lag >1h for 30m | Critical | Worker may be stuck |
| OCR Spike | >50% OCR for 15m | Info | Expected for PDFs |

### Alert Response Playbook

1. **Check Grafana** - Which alert fired?
2. **Check logs** - `{service_name="onlinelib-worker"} | json | level="Error"`
3. **Check traces** - Find failed spans
4. **Check metrics** - Resource exhaustion?
5. **Check infrastructure** - Docker, DB, storage healthy?

---

## Common Troubleshooting

### No Logs in Loki

```bash
# Check Loki is running
docker logs textstack_loki_prod

# Check OTEL collector
docker logs textstack_otel_prod | grep -i log

# Verify logs pipeline
curl http://localhost:3100/ready
```

### No Metrics in Prometheus

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check OTEL collector metrics endpoint
curl http://localhost:8889/metrics

# Verify connection
docker logs textstack_prometheus_prod
```

### Dashboard Shows "No Data"

1. Check time range (top right) - data may be outside range
2. Check if services are running and producing telemetry
3. Verify datasource connections in Grafana
4. For ingestion dashboards - upload a book to generate data

---

## Configuration

### Environment Variables

```bash
# Enable OTLP export (required for observability)
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317

# Grafana admin password
GRAFANA_ADMIN_PASSWORD=your-secure-password

# Optional: Grafana URL for alerts
GRAFANA_ROOT_URL=https://grafana.yourdomain.com
```

### Data Retention

| Component | Default Retention | Config Location |
|-----------|-------------------|-----------------|
| Prometheus | 30 days | docker-compose `--storage.tsdb.retention.time` |
| Loki | 30 days | `observability/loki/loki-config.yaml` |
| Grafana | Unlimited | Depends on disk |

### Adding Custom Metrics

```csharp
// In TelemetryConstants.cs
public static readonly Counter<long> MyCustomCounter =
    Meter.CreateCounter<long>("my_custom_counter", "items", "Description");

// Usage
TelemetryConstants.MyCustomCounter.Add(1, new("label", "value"));
```

---

## Production Checklist

- [ ] Set strong `GRAFANA_ADMIN_PASSWORD`
- [ ] Configure alert notification channels (email, Slack, etc.)
- [ ] Set appropriate retention periods for your storage capacity
- [ ] Verify all datasources are connected in Grafana
- [ ] Test alerts are firing correctly
- [ ] Set up dashboard auto-refresh for monitoring
- [ ] Create data directories with correct permissions
- [ ] Configure firewall - ports should not be publicly accessible

---

## Files Reference

| File | Purpose |
|------|---------|
| `observability/grafana/provisioning/datasources/` | Grafana datasource configs |
| `observability/grafana/provisioning/dashboards/` | Dashboard provisioning |
| `observability/grafana/dashboards/` | Dashboard JSON files |
| `observability/prometheus/prometheus.yml` | Prometheus scrape config |
| `observability/loki/loki-config.yaml` | Loki configuration |
| `infra/otel/otel-collector-config.yaml` | OTEL Collector pipelines |
