namespace Application.Ingestion;

/// <summary>Retry cap shared by the ingestion queues: a job that crashed the worker this often ends Failed.</summary>
public static class IngestionRetry
{
    public const int MaxAttempts = 3;
    public const string ExceededAttemptsError = "Exceeded max retry attempts (worker crashed or timed out on every attempt)";
}
