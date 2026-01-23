namespace TextStack.Extraction.Enums;

public enum ExtractionWarningCode
{
    UnsupportedFormat = 0,
    EmptyContent = 1,
    PartialExtraction = 2,
    EmptyFile = 3,
    UnknownEncoding = 4,
    ParseError = 5,
    ChapterParseError = 6,
    NoTextLayer = 7,
    PageParseError = 8,
    OcrPageLimitExceeded = 9,
    OcrFailed = 10,
    CoverExtractionFailed = 11
}
