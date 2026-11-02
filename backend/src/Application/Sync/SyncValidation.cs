using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Contracts.V2;
using static Contracts.V2.SyncLimits;

namespace Application.Sync;

/// <summary>
/// The payload rules of v2-sync-protocol.md "Payloads": each check answers null when the value
/// passes, else a 400 <c>invalid_payload</c> naming the field. The schema's CHECKs stay the backstop.
/// </summary>
public static class SyncValidation
{
    // \z, not $: .NET's $ also matches before a trailing newline, which the schema's CHECK then refuses.
    private static readonly Regex Sha256Hex = new(@"^[0-9a-f]{64}\z", RegexOptions.Compiled);

    private const int MaxTocBytes = 256 * 1024;
    private const int MaxQuoteCodePoints = 64;
    private const int MaxContextCodePoints = 32;

    /// <summary>ADR-019's clock skew: a client time further ahead than this is a broken clock, not an answer.</summary>
    // Checked against the API's clock while the rows are stamped by the database's: fine at 5 minutes.
    public static readonly TimeSpan MaxClockSkew = TimeSpan.FromMinutes(5);

    /// <summary>A client time no further ahead of <paramref name="now"/> than <see cref="MaxClockSkew"/>.</summary>
    public static SyncResult? NotFuture(DateTimeOffset? at, DateTimeOffset now, string field) =>
        at > now + MaxClockSkew ? SyncResult.Invalid(field, $"{field} is in the future.") : null;

    /// <summary>Lowercase hex only: the client keys its local files by it, so uppercase is refused, never lowered.</summary>
    public static SyncResult? Sha256(string? value, string field = "sha256") =>
        value is not null && Sha256Hex.IsMatch(value) ? null : SyncResult.Invalid(field, "sha256 must be 64 lowercase hex digits.");

    /// <summary>A file version from a client under <paramref name="prefix"/> (<c>file.</c>); <c>html</c> is server-only (clips).</summary>
    public static SyncResult? File(string prefix, BookFileRequest? file) =>
        Required(file, prefix.TrimEnd('.'))
        ?? Sha256(file!.Sha256, prefix + "sha256")
        ?? (file.ByteSize > 0 ? null : SyncResult.Invalid(prefix + "byteSize", "byteSize must be positive."))
        ?? RequiredText(file.OriginalName, prefix + "originalName")
        ?? (file.Format is "epub" or "pdf" ? null : SyncResult.Invalid(prefix + "format", "format must be epub or pdf."))
        ?? (file.Toc is null ? null : Toc(file.Toc, prefix + "toc"));

    // The size first, on the raw text that is also what gets stored; only then the walk.
    private static SyncResult? Toc(string raw, string field)
    {
        if (Utf8Cap(Encoding.UTF8.GetByteCount(raw), field, MaxTocBytes) is { } tooBig) return tooBig;
        using var toc = JsonDocument.Parse(raw);
        return toc.RootElement.ValueKind == JsonValueKind.Array ? Json(toc.RootElement, field) : SyncResult.Invalid(field, "toc must be a JSON array of at most 256 KB.");
    }

    /// <summary>The fields a client edits, as one value: an import's and a merged PATCH's alike.</summary>
    public static SyncResult? Metadata(Application.Library.BookMetadata m) =>
        RequiredText(m.Title, "title") ?? Tags(m.Tags) ?? Text(m.Author, "author") ?? Text(m.Language, "language")
        ?? Text(m.Description, "description") ?? Text(m.Genre, "genre");

    /// <summary>An example's provenance hangs on its book: a file version or a chapter key without one is refused.</summary>
    public static SyncResult? Example(VocabularyExampleRequest e, string prefix = "") =>
        ClientId(e.OperationId, prefix + "operationId") ?? RequiredText(e.Sentence, prefix + "sentence", MaxSentence)
        ?? Text(e.ContextualTranslation, prefix + "contextualTranslation", MaxContextualTranslation)
        ?? Text(e.BookTitle, prefix + "bookTitle", MaxBookTitle)
        ?? (e.ChapterKey is null ? null : RequiredText(e.ChapterKey, prefix + "chapterKey", MaxChapterKey))
        ?? (e.BookId is null && (e.FileId is not null || e.ChapterKey is not null)
            ? SyncResult.Invalid(prefix + "bookId", "fileId and chapterKey need bookId.") : null);

    /// <summary>A client-minted id: present and not the empty UUID (the PDD's ids are v4).</summary>
    public static SyncResult? ClientId(Guid? id, string field) =>
        id is null || id == Guid.Empty ? SyncResult.Invalid(field, $"{field} must be a client-minted UUID.") : null;

    /// <summary>
    /// <paramref name="text"/> cut to <paramref name="max"/> UTF-16 units, the unit the length caps here
    /// check, without splitting a surrogate pair (half of one has no UTF-8 form). For server-written text
    /// that must pass the same caps when read back (chapter keys and titles).
    /// </summary>
    public static string Truncate(string text, int max) =>
        text.Length <= max ? text : text[..(char.IsHighSurrogate(text[max - 1]) ? max - 1 : max)];

    /// <summary>Present, not blank, and storable (<see cref="Text"/>).</summary>
    public static SyncResult? RequiredText(string? value, string field) =>
        string.IsNullOrWhiteSpace(value) ? SyncResult.Invalid(field, $"{field} is required.") : Text(value, field);

    /// <summary><see cref="RequiredText(string?, string)"/> with a length cap.</summary>
    public static SyncResult? RequiredText(string? value, string field, int max) =>
        string.IsNullOrWhiteSpace(value) ? SyncResult.Invalid(field, $"{field} is required.") : Text(value, field, max);

    /// <summary><see cref="Text(string?, string)"/> with a length cap, in UTF-16 units.</summary>
    public static SyncResult? Text(string? value, string field, int max) =>
        value?.Length > max ? SyncResult.Invalid(field, $"{field} is at most {max} characters.") : Text(value, field);

    /// <summary>
    /// One field of a merge-patch: an absent member keeps <paramref name="kept"/>, null clears it, a
    /// string replaces it (checked by <see cref="Text(string?, string, int)"/>).
    /// </summary>
    public static SyncResult? Merge(JsonElement sent, string? kept, string field, out string? merged, int max = int.MaxValue)
    {
        merged = kept;
        try
        {
            if (sent.ValueKind != JsonValueKind.Undefined) merged = sent.Deserialize<string?>();
            return Text(merged, field, max);
        }
        // A wrong type, or an escaped lone surrogate a string cannot even be read from.
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            return SyncResult.Invalid(field, $"{field} is a string or null.");
        }
    }

    /// <summary><see cref="RequiredText(string?, string)"/> capped in UTF-8 bytes: the bodies the PDD bounds in KB.</summary>
    public static SyncResult? RequiredUtf8(string? value, string field, int maxBytes) =>
        RequiredText(value, field) ?? Utf8Cap(Encoding.UTF8.GetByteCount(value!), field, maxBytes);

    private static SyncResult? Utf8Cap(int bytes, string field, int maxBytes) =>
        bytes > maxBytes ? SyncResult.Invalid(field, $"{field} is at most {maxBytes / 1024} KB.") : null;

    private static readonly JsonDocumentOptions NoDuplicateMembers = new() { AllowDuplicateProperties = false };

    /// <summary>
    /// A required JSON array of storable text and finite numbers, at most <paramref name="maxBytes"/> as sent. A repeated
    /// member name is refused: jsonb keeps only the last, so the stored value would hash unlike the request.
    /// </summary>
    public static SyncResult? JsonArray(JsonElement? value, string field, int maxBytes)
    {
        if (value is not { ValueKind: JsonValueKind.Array } array) return SyncResult.Invalid(field, $"{field} must be a JSON array.");
        var raw = JsonMarshal.GetRawUtf8Value(array);
        if (Utf8Cap(raw.Length, field, maxBytes) is { } tooBig) return tooBig;
        try
        {
            using var _ = JsonDocument.Parse(raw.ToArray(), NoDuplicateMembers);
        }
        catch (JsonException)
        {
            return SyncResult.Invalid(field, $"{field} repeats a member name.");
        }
        return Json(array, field);
    }

    public static SyncResult? Tags(string[]? tags) =>
        tags is null || tags.All(t => !string.IsNullOrWhiteSpace(t) && IsStorable(t)) ? null : SyncResult.Invalid("tags", "tags must be non-blank strings.");

    /// <summary>
    /// Text Postgres can store: no U+0000 (22021 in a text column) and no unpaired surrogate (no UTF-8
    /// form). Refused as the client's 400, never left to surface as a 500 that jams its outbox.
    /// </summary>
    public static SyncResult? Text(string? value, string field) =>
        value is null || IsStorable(value) ? null : SyncResult.Invalid(field, $"{field} holds a NUL or an unpaired surrogate.");

    /// <summary>
    /// <see cref="Text"/> for every string and member name inside opaque client JSON (jsonb refuses \u0000
    /// with 22P05), and every number finite (the canonical hash writes doubles, RFC 8785; 1e400 has none).
    /// </summary>
    public static SyncResult? Json(JsonElement value, string field) =>
        IsStorable(value) ? null : SyncResult.Invalid(field, $"{field} holds a NUL, an unpaired surrogate or an out-of-range number.");

    private static bool IsStorable(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\0') return false;
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) i++;
            else if (char.IsSurrogate(c)) return false;
        }
        return true;
    }

    private static bool IsStorable(JsonElement value)
    {
        try
        {
            return value.ValueKind switch
            {
                JsonValueKind.Object => value.EnumerateObject().All(m => IsStorable(m.Name) && IsStorable(m.Value)),
                JsonValueKind.Array => value.EnumerateArray().All(IsStorable),
                JsonValueKind.String => IsStorable(value.GetString()!),
                JsonValueKind.Number => value.TryGetDouble(out var number) && double.IsFinite(number),
                _ => true,
            };
        }
        // An escaped lone surrogate: JsonElement cannot even read it as a string.
        catch (InvalidOperationException)
        {
            return false;
        }
    }

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
        if (Json(locator, field) is { } unstorable) return unstorable;
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
