using OnlineLib.Extraction.Enums;

namespace OnlineLib.Extraction.Contracts;

public sealed record ContentUnit(
    ContentUnitType Type,
    string? Title,
    string? Html,
    string PlainText,
    int OrderIndex,
    int? WordCount = null,
    int? OriginalChapterNumber = null,
    int? PartNumber = null,
    int? TotalParts = null
);
