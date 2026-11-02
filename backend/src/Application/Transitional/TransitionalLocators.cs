using System.Text.Json;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped with <c>book_chapters</c> at R8 (#1040, M6.4); see ADR-031 "Locator schemes".
/// <para>The chapter pre-check of the legacy reader's <c>textstack-*</c> locators (owner decision
/// 2026-11-02, #1112): accepted only on a file version whose extracted chapters include the one the
/// locator names. Never converted to anything: the locator is stored as sent.</para>
/// </summary>
public static class TransitionalLocators
{
    /// <summary>
    /// Whether any of <paramref name="locators"/>, already valid (<see cref="Sync.SyncValidation.Locator"/>),
    /// is a <c>textstack-*</c> one whose chapter <paramref name="fileId"/> does not have. Other schemes ask nothing.
    /// </summary>
    public static async Task<bool> NameAMissingChapterAsync(
        this IBookChapterRepository chapters, Guid userId, Guid fileId, IEnumerable<JsonElement?> locators, CancellationToken ct)
    {
        foreach (var locator in locators)
            if (locator is { } l && ChapterKeyOf(l) is { } key && !await chapters.ExistsAsync(userId, fileId, key, ct))
                return true;
        return false;
    }

    private static string? ChapterKeyOf(JsonElement locator) => locator.GetProperty("scheme").GetString() switch
    {
        "textstack-position-v1" => locator.GetProperty("value").GetProperty("chapterSlug").GetString(),
        "textstack-anchor-v1" => locator.GetProperty("value").GetProperty("chapterKey").GetString(),
        _ => null,
    };
}
