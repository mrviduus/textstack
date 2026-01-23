using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Registry;

public sealed class ExtractorRegistry : IExtractorRegistry
{
    private static readonly Dictionary<string, SourceFormat> ExtensionMap = new(StringComparer.OrdinalIgnoreCase)
    {
        [".txt"] = SourceFormat.Txt,
        [".md"] = SourceFormat.Md,
        [".epub"] = SourceFormat.Epub,
        [".pdf"] = SourceFormat.Pdf,
        [".fb2"] = SourceFormat.Fb2
    };

    private readonly Dictionary<SourceFormat, ITextExtractor> _extractors;
    private readonly UnsupportedTextExtractor _fallback = new();

    public ExtractorRegistry(IEnumerable<ITextExtractor> extractors)
    {
        _extractors = extractors
            .Where(e => e is not UnsupportedTextExtractor)
            .ToDictionary(e => e.SupportedFormat);
    }

    public SourceFormat DetectFormat(ExtractionRequest request)
    {
        var extension = Path.GetExtension(request.FileName);
        if (string.IsNullOrEmpty(extension))
            return SourceFormat.Unknown;

        return ExtensionMap.GetValueOrDefault(extension, SourceFormat.Unknown);
    }

    public ITextExtractor Resolve(ExtractionRequest request)
    {
        var format = DetectFormat(request);
        return _extractors.GetValueOrDefault(format, _fallback);
    }
}
