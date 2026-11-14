namespace Contracts.V2;

/// <summary>
/// The caps of the /me/v2 payloads, read by the server's validation and by the MCP bridge's tool
/// schemas, so the two cannot drift. Text caps are UTF-16 units unless named <c>Bytes</c> (UTF-8).
/// </summary>
public static class SyncLimits
{
    // Vocabulary (legacy's where it had one, which reads them from here; past them the key index 500s).
    public const int MaxLanguage = 16;
    public const int MaxWord = 200;
    public const int MaxTranslation = 500;
    public const int MaxDefinition = 2000;
    public const int MaxSentence = 1000;
    public const int MaxContextualTranslation = 4000;
    public const int MaxBookTitle = 500;
    public const int MaxChapterKey = 200;
    public const int MaxReviewMode = 64;

    // Annotations: legacy has no cap on highlight text; a selection past this is not a highlight.
    public const int MaxSelectedText = 4000;

    // A page-name locator's page key (a CBZ entry name, a fixed-layout EPUB section): a zip path, not prose.
    public const int MaxPageName = 512;

    // A text anchor's prefix/suffix, in code points.
    public const int MaxContextCodePoints = 32;

    // Shares and checkpoints (v2-sync-protocol.md "Shares and checkpoints").
    public const int MaxChapterTitle = 500;
    public const int MaxChapterTextBytes = 200 * 1024;
    public const int MaxNotesBytes = 64 * 1024;
    public const int MaxTopic = 500;
    public const int MaxSectionItems = 50;
    public const int MaxSectionsBytes = 32 * 1024;

    // File bytes ("File sync upload protocol"); the part size itself is V2:MaxPartBytes, served by /status.
    public const int MaxParts = 1000;
    public const int MaxCoverBytes = 2 * 1024 * 1024;
}
