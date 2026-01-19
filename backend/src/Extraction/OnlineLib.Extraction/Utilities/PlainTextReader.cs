using System.Text;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Enums;

namespace OnlineLib.Extraction.Utilities;

public static class PlainTextReader
{
    public static async Task<ExtractionResult> ExtractAsync(
        ExtractionRequest request,
        SourceFormat format,
        CancellationToken ct = default)
    {
        var warnings = new List<ExtractionWarning>();
        var text = await ReadTextAsync(request.Content, warnings, ct);
        var normalized = TextProcessingUtils.NormalizeText(text);

        var title = TextProcessingUtils.ExtractTitleFromFileName(request.FileName);
        var metadata = new ExtractionMetadata(title, null, null, null);

        var units = new List<ContentUnit>();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            warnings.Add(new ExtractionWarning(ExtractionWarningCode.EmptyFile, "File contains no text content"));
        }

        units.Add(new ContentUnit(
            Type: ContentUnitType.Chapter,
            Title: null,
            Html: TextProcessingUtils.PlainTextToHtml(normalized),
            PlainText: normalized,
            OrderIndex: 0,
            WordCount: TextProcessingUtils.CountWords(normalized)
        ));

        var diagnostics = new ExtractionDiagnostics(TextSource.NativeText, null, warnings);
        return new ExtractionResult(format, metadata, units, [], diagnostics);
    }

    private static async Task<string> ReadTextAsync(
        Stream stream,
        List<ExtractionWarning> warnings,
        CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        try
        {
            return await reader.ReadToEndAsync(ct);
        }
        catch (DecoderFallbackException)
        {
            warnings.Add(new ExtractionWarning(
                ExtractionWarningCode.UnknownEncoding,
                "Could not decode file encoding, using UTF-8 with replacement"));

            stream.Position = 0;
            using var fallbackReader = new StreamReader(
                stream,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false));
            return await fallbackReader.ReadToEndAsync(ct);
        }
    }
}
