namespace OnlineLib.Extraction.Contracts;

public sealed record ExtractedImage(
    string OriginalPath,
    byte[] Data,
    string MimeType,
    bool IsCover
);
