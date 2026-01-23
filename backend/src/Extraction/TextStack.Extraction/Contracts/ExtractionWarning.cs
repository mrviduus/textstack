using TextStack.Extraction.Enums;

namespace TextStack.Extraction.Contracts;

public sealed record ExtractionWarning(
    ExtractionWarningCode Code,
    string Message
);
