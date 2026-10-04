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
/// The advertised tool surface and the ONE copy of each tool's description: the
/// runtime <c>McpToolCatalog</c> reads them via <see cref="Describe"/> (the Mcp
/// project references this dependency-free assembly). A test still checks the
/// tool NAMES match the catalog.
///
/// Order matches the catalog's: the public catalog tools, then the user's own
/// uploaded library, then their highlights and vocabulary
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
    /// <summary>The one copy of a tool's description, read by the runtime catalog too.</summary>
    public static string Describe(string name) => Tools.First(t => t.Name == name).Description;

    public static IReadOnlyList<McpToolDescriptor> Tools { get; } =
    [
        new("search_books",
            "Search the PUBLIC TextStack catalog for books and chapters matching a query. "
            + "This is the shared library of published books, NOT the user's own uploads — for those, use search_my_library."),
        new("get_book", "Fetch a catalog book by slug: its editionId, metadata, authors, genres, and chapter list."),
        new("get_chapter", "Fetch a chapter's plain text (HTML stripped, length-capped) plus its number, title, and prev/next slugs."),
        new("search_my_library",
            "Full-text search across the books the signed-in user has UPLOADED to TextStack "
            + "(their private library, not the public catalog — requires authentication). "
            + "Returns one hit per book with its bookId, title, author and the best-matching "
            + "chapter slug and excerpt. Pass the bookId to get_my_book or get_my_chapter. "
            + "A bookId is NOT an editionId and will not work with list_my_highlights."),
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
        new("list_my_vocabulary",
            "List the signed-in user's saved vocabulary words, optionally filtered by SRS stage or search (requires authentication). "
            + "Each word carries its id, which is what update_vocabulary_word and delete_vocabulary_word take."),
        new("add_vocabulary_words",
            "Save up to 20 words to the user's TextStack vocabulary, where they are reviewed with spaced repetition "
            + "(WRITE on their own account — requires authentication). Offer this after explaining a word the reader did not "
            + "know; add only words the user asked for or agreed to. "
            + "Each word needs its language, plus a translation in the user's NATIVE language when that differs from the "
            + "word's language, or else a short plain definition (1-2 sentences) when it is the same language or unknown. "
            + "Include the sentence it appeared in. Pass bookId (an uploaded book) or editionId (a catalog "
            + "book) from get_my_reading, never both. Returns one line per word saying what happened to it; a word that "
            + "is already saved is not changed — use update_vocabulary_word for that instead of adding it again."),
        new("update_vocabulary_word",
            "Change the translation and/or definition of a word already in the user's vocabulary (WRITE on their own "
            + "account — requires authentication). Pass the word's id from list_my_vocabulary or add_vocabulary_words "
            + "and at least one of translation or definition."),
        new("delete_vocabulary_word",
            "Remove one word from the user's vocabulary (WRITE on their own account — requires "
            + "authentication). Pass the word's id from list_my_vocabulary. Only when the user clearly asked for it; if "
            + "you are inferring that they want it gone, confirm first. One word per call — there is no bulk delete."),
        new("save_highlight",
            "Saves a highlight to YOUR TextStack library for the given catalog book chapter "
            + "(WRITE on your own account — requires you to be signed in). Pass the editionId "
            + "and chapterId (from get_book), the exact selected text, and optionally a color "
            + "and a note. The highlight is stored and listable via list_my_highlights."),
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
            + "previous one, so a second pass refreshes the notes rather than duplicating them. "
            + "A chapter that has a structured review cannot be overwritten here — use save_chapter_review."),
        new("get_my_insights",
            "Read back everything already worked out about a book and saved with save_insight, in "
            + "reading order (requires authentication). Give EITHER bookId (an uploaded book) OR "
            + "editionId (a catalog book). Call this FIRST when starting to work on a book the reader "
            + "has discussed before — it is what stops the next session repeating the last one."),

        new("get_my_reading",
            "List what the reader is reading right now and what they recently finished, with titles "
            + "and how far in they are (requires authentication). Takes no arguments. Call this FIRST "
            + "when you do not already have a bookId or editionId — nothing else here can find a book "
            + "without one. `source` says which: \"userbook\" means a book they uploaded, addressed by "
            + "`bookId` in the _my_ tools; \"savedbook\" is a catalog book, addressed by `slug` in "
            + "get_book/get_chapter and by `editionId` in the insight tools. `chapterSlug` is where "
            + "they stopped. `allBooks` lists every upload including ones never opened."),

        new("get_book_progress",
            "How far the reader has got in one book, and which chapter they stopped in (requires "
            + "authentication). Give EITHER bookId (a book they uploaded) OR editionId (a catalog "
            + "book). Ask this before discussing a book you have not just been told the position of "
            + "— it is what lets you avoid spoiling what they have not reached yet. A book they have "
            + "never opened has no progress and says so."),

        new("set_book_progress",
            "Record that the reader has FINISHED a chapter, including one they read or listened to "
            + "somewhere else — an audiobook, paper, another app (requires authentication). Give "
            + "EITHER bookId (a book they uploaded) OR slug (a catalog book), plus the chapterSlug "
            + "they finished; get_my_reading and get_book list the slugs. The app then resumes them "
            + "at the START of the next chapter and its progress becomes chapters-finished over "
            + "chapters-total; finishing the last chapter marks the book complete. Only call this "
            + "when the reader says they finished something — it overwrites the exact position their "
            + "reader had stored, and it cannot be undone from here."),

        new("get_chapter_review",
            "Start a TextStack chapter review — everything in one call (requires authentication). "
            + "Give EITHER bookId (an uploaded book) OR editionId (a catalog book), plus chapterSlug. "
            + "Returns the review METHOD to follow, the chapter text, the reader's highlights in it, "
            + "their saved words from this book, open threads from earlier chapters and any previous "
            + "review of this chapter. If chapter.partCount > 1, call again with part = 2..partCount "
            + "before writing. Follow the method exactly and save with save_chapter_review. Usually called "
            + "after a conversation, once the reader agreed to a review. The review covers this chapter "
            + "only: later chapters may come up in conversation, but the review is built from this chapter."),

        new("save_chapter_review",
            "Save a finished TextStack chapter review (WRITE on the reader's account — requires "
            + "authentication). Same book/chapter ids as get_chapter_review. `review` must follow the "
            + "method get_chapter_review returned: 3–6 blocks, each with a concrete problem, a one-line "
            + "rootCause, a rule to memorize, the ids of the reader's highlights it covers (never invent "
            + "ids) and one question with its answer; plus applications and threads. Saving again "
            + "REPLACES the chapter's review. If the save is refused, the error lists every problem — "
            + "fix all of them and save again."),
    ];
}
