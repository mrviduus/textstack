using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Reflection;

namespace Infrastructure.Telemetry;

public static class TelemetryConstants
{
    public static readonly string ServiceVersion =
        Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "1.0.0";

    public const string IngestionActivitySourceName = "TextStack.Ingestion";
    public const string ApiActivitySourceName = "TextStack.Api";
    public const string MeterName = "TextStack.Ingestion";
}

public static class IngestionActivitySource
{
    public static readonly ActivitySource Source = new(
        TelemetryConstants.IngestionActivitySourceName,
        TelemetryConstants.ServiceVersion);
}

public static class ApiActivitySource
{
    public static readonly ActivitySource Source = new(
        TelemetryConstants.ApiActivitySourceName,
        TelemetryConstants.ServiceVersion);
}

public static class IngestionMetrics
{
    private static readonly Meter Meter = new(
        TelemetryConstants.MeterName,
        TelemetryConstants.ServiceVersion);

    // Counters
    public static readonly Counter<long> JobsStarted = Meter.CreateCounter<long>(
        "ingestion_jobs_started_total",
        description: "Total ingestion jobs started");

    public static readonly Counter<long> JobsSucceeded = Meter.CreateCounter<long>(
        "ingestion_jobs_succeeded_total",
        description: "Total ingestion jobs succeeded");

    public static readonly Counter<long> JobsFailed = Meter.CreateCounter<long>(
        "ingestion_jobs_failed_total",
        description: "Total ingestion jobs failed");

    public static readonly Counter<long> OcrUsed = Meter.CreateCounter<long>(
        "extraction_ocr_used_total",
        description: "Total OCR extractions performed");

    // Histograms
    public static readonly Histogram<double> JobDuration = Meter.CreateHistogram<double>(
        "ingestion_job_duration_ms",
        unit: "ms",
        description: "Ingestion job duration in milliseconds");

    public static readonly Histogram<double> ExtractionDuration = Meter.CreateHistogram<double>(
        "extraction_duration_ms",
        unit: "ms",
        description: "Extraction duration in milliseconds");

    // Gauges (via ObservableGauge - values set via callbacks)
    private static int _jobsInProgress;
    private static int _jobsPending;
    private static double _oldestPendingJobAgeMs;

    public static void SetJobsInProgress(int count) => _jobsInProgress = count;
    public static void SetJobsPending(int count) => _jobsPending = count;
    public static void SetOldestPendingJobAge(double ageMs) => _oldestPendingJobAgeMs = ageMs;

    static IngestionMetrics()
    {
        Meter.CreateObservableGauge(
            "ingestion_jobs_in_progress",
            () => _jobsInProgress,
            description: "Number of jobs currently being processed");

        Meter.CreateObservableGauge(
            "ingestion_jobs_pending",
            () => _jobsPending,
            description: "Number of jobs waiting in queue");

        Meter.CreateObservableGauge(
            "ingestion_queue_lag_ms",
            () => _oldestPendingJobAgeMs,
            unit: "ms",
            description: "Age of oldest pending job in milliseconds");
    }
}
