# Restoring Tempo (Distributed Tracing)

Tempo was removed on 2026-01-16 to save ~350MB RAM. This document describes how to restore it if needed.

## Why Tempo Was Removed

- Memory usage: ~350MB RAM
- Not actively used for debugging at current project scale
- Traces are still collected by OTEL, just not stored

## When to Restore Tempo

Consider restoring Tempo when:
- Debugging complex request flows across services
- Performance profiling needs span-level detail
- Team grows and distributed tracing becomes valuable
- Moving to microservices architecture

## Files to Restore

### 1. docker-compose.prod.yml

Add Tempo service:

```yaml
  tempo:
    image: grafana/tempo:2.6.1
    container_name: textstack_tempo_prod
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./observability/tempo/tempo.yaml:/etc/tempo.yaml:ro
      - ./data/tempo-prod:/var/tempo
    restart: always
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 128M
```

Update `otel-collector` depends_on:
```yaml
  otel-collector:
    depends_on:
      - tempo  # Add this
      - loki
```

Update `grafana` depends_on and environment:
```yaml
  grafana:
    environment:
      GF_FEATURE_TOGGLES_ENABLE: "traceqlEditor"  # Add this
    depends_on:
      - prometheus
      - tempo  # Add this
```

### 2. docker-compose.yml (dev)

Same changes as prod, but with different container names and ports:

```yaml
  tempo:
    image: grafana/tempo:2.6.1
    container_name: books_tempo
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./observability/tempo/tempo.yaml:/etc/tempo.yaml:ro
      - ./data/tempo:/var/tempo
    ports:
      - "3200:3200"   # Tempo HTTP
      - "9095:9095"   # Tempo gRPC
    restart: unless-stopped
```

### 3. infra/otel/otel-collector-config.yaml

Add Tempo exporter:

```yaml
exporters:
  # ... existing exporters ...

  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
```

Update traces pipeline:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlp/tempo]  # Add otlp/tempo
```

### 4. observability/grafana/provisioning/datasources/datasources.yaml

Add Tempo datasource:

```yaml
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
    jsonData:
      httpMethod: GET
      tracesToMetrics:
        datasourceUid: prometheus
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true
      lokiSearch:
        datasourceUid: loki
```

Update Loki datasource to add trace correlation:

```yaml
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"(\w+)"'
          name: TraceID
          url: '$${__value.raw}'
```

### 5. Tempo config file

The config file already exists at `observability/tempo/tempo.yaml`:

```yaml
stream_over_http_enabled: true

server:
  http_listen_port: 3200
  grpc_listen_port: 9095

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 72h  # Adjust retention as needed

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks

metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
        send_exemplars: true

overrides:
  defaults:
    metrics_generator:
      processors: [service-graphs, span-metrics]
```

## Deployment Steps

1. Update config files as described above
2. Create data directory:
   ```bash
   mkdir -p data/tempo-prod
   sudo chmod 777 data/tempo-prod
   ```
3. Restart stack:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```
4. Verify Tempo is running:
   ```bash
   curl http://localhost:3200/ready
   ```
5. Check Grafana has Tempo datasource: Grafana → Explore → Select Tempo

## Useful TraceQL Queries

```traceql
# All traces from worker
{service.name="onlinelib-worker"}

# Slow traces (>10s)
{service.name="onlinelib-worker"} | duration > 10s

# Failed traces
{service.name="onlinelib-worker" && status=error}

# Specific operation
{name="ingestion.job.process"}

# By book format
{name="extraction.run" && resource.format="epub"}
```

## Memory Considerations

Tempo uses ~350MB RAM with default config. To reduce:

1. Decrease retention: `compactor.compaction.block_retention: 24h`
2. Reduce ingester buffer: `ingester.max_block_duration: 2m`
3. Disable metrics generator (saves ~50MB):
   ```yaml
   # Comment out metrics_generator section
   ```

## Related Commits

- Removal commit: `f360ec3` (2026-01-16)
- Original setup: See `docs/05-features/feat-0005-observability-opentelemetry.md`
