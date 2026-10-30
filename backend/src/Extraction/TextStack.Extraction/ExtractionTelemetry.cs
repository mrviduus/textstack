namespace TextStack.Extraction;

public static class ExtractionTelemetry
{
    /// <summary>Ingestion meter; Infrastructure's TelemetryConstants.MeterName is this, so the OTel exporter picks it up.</summary>
    public const string MeterName = "TextStack.Ingestion";
}
