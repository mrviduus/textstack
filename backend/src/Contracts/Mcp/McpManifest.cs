namespace Contracts.Mcp;

/// <summary>
/// Machine-readable MCP discovery manifest (AI-052). Served publicly at
/// <c>/.well-known/mcp/manifest.json</c> (nginx exact-match → API <c>/mcp/manifest</c>)
/// so MCP clients / tooling can discover the live streamable-HTTP endpoint, how to
/// authenticate, and the tool surface — WITHOUT colliding with the live protocol
/// endpoint at <c>/mcp</c> (an nginx prefix owned by the mcp-server container).
/// </summary>
public sealed record McpManifest(
    string Name,
    string Version,
    string Description,
    string Transport,
    string Endpoint,
    McpManifestAuth Auth,
    string Documentation,
    IReadOnlyList<McpToolDescriptor> Tools);

/// <summary>How a client obtains credentials for the MCP endpoint.</summary>
public sealed record McpManifestAuth(string Type, string HowTo);

/// <summary>One advertised tool: name + human description (mirrors the runtime catalog).</summary>
public sealed record McpToolDescriptor(string Name, string Description);

/// <summary>
/// The advertised tool surface, VERBATIM from the runtime <c>McpToolCatalog</c>
/// (the source of truth in the Mcp project). The API cannot reference the Mcp
/// executable, so the pairs are mirrored here; a drift test in
/// <c>TextStack.Ai.Mcp.Tests</c> fails if these diverge from the catalog.
///
/// Order matches the catalog's: the public catalog tools, then the user's own
/// uploaded library, then their highlights and vocabulary, then <c>ask_book</c>
/// and the WRITE tool <c>save_highlight</c>.
///
/// Two search tools is deliberate, not duplication. The catalog and a user's
/// uploads are separate aggregates with separate identifiers — a catalog book has
/// an <c>editionId</c>, an upload has a <c>bookId</c>, and neither works in the
/// other's tools. The descriptions carry that distinction because the tool name
/// alone does not.
/// </summary>
public static class McpManifestCatalog
{
    public static IReadOnlyList<McpToolDescriptor> Tools { get; } =
    [
        new("search_books",
            "Search the PUBLIC TextStack catalog for books and chapters matching a query. "
            + "This is the shared library of published books, NOT the user's own uploads — for those, use search_my_library."),
        new("get_book", "Fetch a catalog book by slug: its editionId (for ask_book), metadata, authors, genres, and chapter list."),
        new("get_chapter", "Fetch a chapter's plain text (HTML stripped, length-capped) plus its number, title, and prev/next slugs."),
        new("search_my_library",
            "Full-text search across the books the signed-in user has UPLOADED to TextStack "
            + "(their private library, not the public catalog — requires authentication). "
            + "Returns one hit per book with its bookId, title, author and the best-matching "
            + "chapter slug and excerpt. Pass the bookId to get_my_book or get_my_chapter. "
            + "A bookId is NOT an editionId and will not work with ask_book or list_my_highlights."),
        new("get_my_book",
            "Fetch one of the signed-in user's UPLOADED books by bookId (from search_my_library): "
            + "its metadata and its full chapter list (requires authentication). Each chapter "
            + "carries a chapterId and a slug — the slug goes to get_my_chapter, the chapterId to "
            + "save_my_highlight."),
        new("get_my_chapter",
            "Fetch one chapter of a book the signed-in user UPLOADED: its plain text "
            + "(HTML stripped, length-capped) plus its chapterId, number, title and prev/next "
            + "slugs (requires authentication). The chapterId it returns is what save_my_highlight "
            + "needs."),
        new("list_my_highlights", "List the signed-in user's highlights for a given edition (requires authentication)."),
        new("list_my_vocabulary", "List the signed-in user's saved vocabulary words, optionally filtered by SRS stage or search (requires authentication)."),
        new("save_highlight",
            "Saves a highlight to YOUR TextStack library for the given catalog book chapter "
            + "(WRITE on your own account — requires you to be signed in). Pass the editionId "
            + "and chapterId (from get_book), the exact selected text, and optionally a color "
            + "and a note. The highlight is stored and listable via list_my_highlights."),
        new("ask_book", "Ask a question about a book the user is reading; spoiler-safe (answers only from chapters already read). Requires authentication."),
        new("save_my_highlight",
            "Highlight a passage in one of the books the user UPLOADED (WRITE on their own account — "
            + "requires authentication). Pass the bookId, the chapterId of the chapter the passage is "
            + "in (from get_my_book or get_my_chapter), and the exact text as it appears in that "
            + "chapter — it is matched against the chapter text to place the highlight, so quote it "
            + "verbatim. Optionally a color and a note. The highlight is listed by "
            + "list_my_book_highlights and appears in the reader — EXCEPT on a book get_my_book "
            + "reports as rendersAsOriginalPdf, where it is saved and listed but not drawn over the "
            + "page, because a PDF highlight is placed by page geometry this tool cannot produce. "
            + "Highlight what is worth returning to, not every interesting line: a book marked end "
            + "to end is a book with no marks, and there is a hard limit of 200 per book."),
        new("list_my_book_highlights",
            "List the highlights already saved in one of the books the user UPLOADED, by bookId "
            + "(requires authentication). Use it before highlighting to see what is already marked. "
            + "For a book from the public catalog use list_my_highlights with its editionId instead."),
        new("save_insight",
            "Write a conclusion back into a book so the reader finds it there later (WRITE on their "
            + "own account — requires authentication). Give EITHER bookId (a book they uploaded) OR "
            + "editionId (a catalog book). Pass chapterSlug when the conclusion is about one chapter, "
            + "and leave it out when it is about the whole book — that book-level one is the конспект's "
            + "overview. `text` is Markdown; `question` records what was being worked out, which is "
            + "what makes it worth coming back to. Saving again for the same chapter REPLACES the "
            + "previous one, so a second pass refreshes the notes rather than duplicating them."),
        new("get_my_insights",
            "Read back everything already worked out about a book and saved with save_insight, in "
            + "reading order (requires authentication). Give EITHER bookId (an uploaded book) OR "
            + "editionId (a catalog book). Call this FIRST when starting to work on a book the reader "
            + "has discussed before — it is what stops the next session repeating the last one."),
    ];
}
