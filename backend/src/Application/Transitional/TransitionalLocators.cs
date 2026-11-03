using System.Text.Json;
using Domain.Reading;

namespace Application.Transitional;

/// <summary>
/// The chapters a reading-state write's <c>textstack-*</c> locators name, each null for another scheme:
/// its position's, and its offered frontier's (<see cref="ReadingState.Furthest"/> of the frontier and the position).
/// </summary>
public readonly record struct TransitionalChapterKeys(string? Current, string? Frontier);

/// <summary>
/// Transitional. Dropped with <c>book_chapters</c> at R8 (#1040, M6.4); see ADR-031 "Locator schemes".
/// <para>The legacy reader's <c>textstack-*</c> locators (owner decision 2026-11-02, #1112) are accepted
/// only on a file version whose extracted chapters include the one they name. Never converted to
/// anything: the locator is stored as sent.</para>
/// </summary>
public static class TransitionalLocators
{
    public static TransitionalChapterKeys ChapterKeysOf(ReadingState write)
    {
        var (frontier, _) = ReadingState.Furthest((write.FrontierLocator, write.FrontierFraction), (write.CurrentLocator, write.BookFraction));
        return new(ChapterKeyOf(write.CurrentLocator), ChapterKeyOf(frontier));
    }

    /// <summary>The chapter a valid locator (<see cref="Sync.SyncValidation.Locator"/>) names; null for a scheme other than <c>textstack-*</c>.</summary>
    public static string? ChapterKeyOf(string? locator)
    {
        if (locator is null) return null;
        using var json = JsonDocument.Parse(locator);
        var root = json.RootElement;
        return root.GetProperty("scheme").GetString() switch
        {
            "textstack-position-v1" => root.GetProperty("value").GetProperty("chapterSlug").GetString(),
            "textstack-anchor-v1" => root.GetProperty("value").GetProperty("chapterKey").GetString(),
            _ => null,
        };
    }
}
