using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Contracts.V2;

namespace Application.Sync;

/// <summary>
/// The payload rules of v2-sync-protocol.md "Payloads": each check answers null when the value
/// passes, else a 400 <c>invalid_payload</c> naming the field. The schema's CHECKs stay the backstop.
/// </summary>
public static class SyncValidation
{
    private static readonly Regex Sha256Hex = new("^[0-9a-f]{64}$", RegexOptions.Compiled);

    private const int MaxTocBytes = 256 * 1024;
    private const int MaxQuoteCodePoints = 64;
    private const int MaxContextCodePoints = 32;

    /// <summary>Lowercase hex only: the client keys its local files by it, so uppercase is refused, never lowered.</summary>
    public static SyncResult? Sha256(string? value, string field = "sha256") =>
        value is not null && Sha256Hex.IsMatch(value) ? null : SyncResult.Invalid(field, "sha256 must be 64 lowercase hex digits.");

    /// <summary>A file version from a client; <c>html</c> is server-only (clips).</summary>
    public static SyncResult? File(string prefix, string? sha256, long? byteSize, string? originalName, string? format, JsonElement? toc) =>
        Sha256(sha256, prefix + "sha256")
        ?? (byteSize > 0 ? null : SyncResult.Invalid(prefix + "byteSize", "byteSize must be positive."))
        ?? (string.IsNullOrWhiteSpace(originalName) ? SyncResult.Invalid(prefix + "originalName", "originalName is required.") : null)
        ?? (format is "epub" or "pdf" ? null : SyncResult.Invalid(prefix + "format", "format must be epub or pdf."))
        ?? (toc is null || toc.Value.ValueKind == JsonValueKind.Array && Encoding.UTF8.GetByteCount(toc.Value.GetRawText()) <= MaxTocBytes
            ? null : SyncResult.Invalid(prefix + "toc", "toc must be a JSON array of at most 256 KB."));

    public static SyncResult? Title(string? title) =>
        string.IsNullOrWhiteSpace(title) ? SyncResult.Invalid("title", "title is required.") : null;

    public static SyncResult? Tags(string[]? tags) =>
        tags is null || tags.All(t => !string.IsNullOrWhiteSpace(t)) ? null : SyncResult.Invalid("tags", "tags must be non-blank strings.");

    public static SyncResult? Fraction(decimal? value, string field) =>
        value is >= 0 and <= 1 ? null : SyncResult.Invalid(field, $"{field} must be between 0 and 1.");

    public static SyncResult? Required(object? value, string field) =>
        value is null ? SyncResult.Invalid(field, $"{field} is required.") : null;

    /// <summary>Where a locator is written: the reading position needs a quote, an annotation may carry context.</summary>
    public enum LocatorUse { Position, Annotation }

    /// <summary>
    /// The ADR-031 envelope with the two schemes a V2 writer produces: <c>epub-cfi</c> (the CFI is
    /// opaque, never parsed) and <c>pdf-page</c>. The <c>textstack-*</c> schemes exist for migrated rows only.
    /// </summary>
    public static SyncResult? Locator(JsonElement locator, string field, LocatorUse use)
    {
        if (locator.ValueKind != JsonValueKind.Object
            || !locator.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || version.GetRawText() != "1"
            || !locator.TryGetProperty("value", out var value) || value.ValueKind == JsonValueKind.Null)
            return SyncResult.Invalid(field, "A locator is {\"version\":1,\"scheme\":…,\"value\":…}.");
        var scheme = locator.TryGetProperty("scheme", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        return scheme switch
        {
            "epub-cfi" => EpubCfi(locator, value, field, use),
            "pdf-page" => locator.TryGetProperty("quote", out _) ? SyncResult.Invalid(field, "Only epub-cfi carries a quote.")
                : use == LocatorUse.Position ? (IsPage(value) && value.EnumerateObject().Count() == 1 ? null : SyncResult.Invalid(field, "A pdf-page position is {\"page\":N}."))
                : IsPdfAnchor(value) ? null : SyncResult.Invalid(field, "A pdf-page annotation is {\"page\":N,\"rects\":[{x,y,w,h}],\"exact\":…}."),
            _ => SyncResult.Invalid(field, "V2 writes take the epub-cfi and pdf-page schemes only."),
        };
    }

    private static SyncResult? EpubCfi(JsonElement locator, JsonElement value, string field, LocatorUse use)
    {
        if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
            return SyncResult.Invalid(field, "An epub-cfi value is the CFI string.");
        var hasQuote = locator.TryGetProperty("quote", out var quote);
        if (use == LocatorUse.Position && !hasQuote)
            return SyncResult.Invalid(field, "A reading position needs the quote at its CFI.");
        if (hasQuote && !IsText(quote, 1, MaxQuoteCodePoints))
            return SyncResult.Invalid(field, "quote is 1-64 characters.");
        foreach (var context in (string[])["prefix", "suffix"])
            if (locator.TryGetProperty(context, out var text) && !IsText(text, 0, MaxContextCodePoints))
                return SyncResult.Invalid(field, $"{context} is at most 32 characters.");
        return null;
    }

    private static bool IsText(JsonElement e, int min, int max) =>
        e.ValueKind == JsonValueKind.String && e.GetString()!.EnumerateRunes().Count() is var n && n >= min && n <= max;

    private static bool IsPage(JsonElement value) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty("page", out var page)
        && page.ValueKind == JsonValueKind.Number && page.TryGetInt32(out var n) && n >= 1;

    private static bool IsPdfAnchor(JsonElement value) =>
        IsPage(value)
        && value.TryGetProperty("exact", out var exact) && exact.ValueKind == JsonValueKind.String
        && value.TryGetProperty("rects", out var rects) && rects.ValueKind == JsonValueKind.Array
        && rects.EnumerateArray().All(r => r.ValueKind == JsonValueKind.Object
            && ((string[])["x", "y", "w", "h"]).All(k => r.TryGetProperty(k, out var n) && n.ValueKind == JsonValueKind.Number));
}
