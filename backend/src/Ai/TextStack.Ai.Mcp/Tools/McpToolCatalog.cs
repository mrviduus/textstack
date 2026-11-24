using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp.Http;

namespace TextStack.Ai.Mcp.Tools;

/// <summary>
/// The runtime catalog of MCP tools the server exposes. <c>tools/list</c> and <c>tools/call</c> are
/// served from this list, so adding a tool is a single append + its handler.
///
/// Tool handlers contain only validation + mapping. Upstream timeout / transport
/// / parse faults are handled centrally by <see cref="InvokeAsync"/> so every tool
/// returns a clean <c>IsError</c> instead of a JSON-RPC protocol fault, while a
/// genuine caller cancellation still propagates.
///
/// Every tool requires a Bearer token; when none is available they return a clean
/// auth-required <c>IsError</c> and never issue the HTTP call. All tools are ALWAYS listed
/// (stable discovery) regardless of token presence — only the call fails-clean.
/// </summary>
public sealed partial class McpToolCatalog
{
    private readonly IReadOnlyDictionary<string, McpToolDescriptor> _byName;
    private readonly ILogger<McpToolCatalog> _logger;

    public McpToolCatalog(TextStackApiClient api, ILogger<McpToolCatalog>? logger = null)
    {
        _logger = logger ?? NullLogger<McpToolCatalog>.Instance;
        var tools = new[]
        {
            BuildSearchMyLibrary(api),
            BuildGetMyBook(api),
            BuildListMyVocabulary(api),
            BuildAddVocabularyWords(api),
            BuildUpdateVocabularyWord(api),
            BuildDeleteVocabularyWord(api),
            BuildSaveMyHighlight(api),
            BuildListMyBookHighlights(api),
            BuildSaveInsight(api),
            BuildGetMyInsights(api),
            BuildGetMyReading(api),
            BuildGetBookProgress(api),
            BuildSetBookProgress(api),
            BuildShareChapter(api),
            BuildSaveCheckpoint(api),
            BuildListCheckpoints(api),
            BuildDeleteCheckpoint(api),
            BuildGetSharedChapter(api),
        };
        _byName = tools.ToDictionary(t => t.Name, StringComparer.Ordinal);
    }

    public List<Tool> ListTools() =>
        _byName.Values.Select(d => d.ToProtocolTool()).ToList();

    /// <summary>
    /// Dispatches a <c>tools/call</c>. Unknown tool → an <c>IsError</c> result
    /// (per MCP convention, tool-level failures are returned, not thrown).
    /// </summary>
    public Task<CallToolResult> CallAsync(string name, JsonElement? arguments, CancellationToken ct)
    {
        if (!_byName.TryGetValue(name, out var descriptor))
            return Task.FromResult(Error($"Unknown tool '{name}'."));

        return descriptor.Handler(arguments, ct);
    }

    // ── shared upstream-error wrapper ────────────────────────────────────────────

    /// <summary>
    /// Runs a tool's upstream call + mapping with uniform fail-clean semantics so
    /// every handler shares one error contract:
    ///   • genuine caller cancellation (token IS cancelled) → rethrows (SDK ends call);
    ///   • HttpClient timeout (cancel surfaces but caller token NOT cancelled) →
    ///     "{tool} failed: upstream timed out";
    ///   • transport (DNS/connection) or parse (non-JSON body) → "{tool} failed: upstream unavailable";
    ///   • <see cref="McpUnauthorizedException"/> → "authentication required …" (user-scoped tools).
    /// The handler body is only validation + the upstream call + mapping.
    /// </summary>
    private async Task<CallToolResult> InvokeAsync(
        string tool, CancellationToken ct, Func<Task<CallToolResult>> body)
    {
        try
        {
            return await body();
        }
        // Missing/invalid token (no token configured, device flow pending, or API
        // answered 401). Clean, expected — never an HTTP fault to surface as
        // "unavailable". For a pending device flow, render the actionable
        // verification URL + code so the user can authorize and retry; otherwise
        // relay the provider's reason (e.g. "no TEXTSTACK_MCP_TOKEN configured").
        catch (McpUnauthorizedException ex)
        {
            return Error(ex.VerificationUri is { } uri && ex.UserCode is { } code
                ? $"authentication required — open {uri} and enter code {code} to connect TextStack, then retry."
                : $"authentication required — {ex.Message}");
        }
        // Real client cancellation (client disconnected) is cooperative — propagate
        // so the SDK ends the call. Only a TIMEOUT (HttpClient's own timeout also
        // surfaces as OperationCanceledException, but with the caller's token NOT
        // cancelled) becomes a clean tool error.
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Error($"{tool} failed: upstream timed out");
        }
        // Transport (DNS/connection) or parse (non-JSON 200 body) failure → clean
        // MCP tool error, not a JSON-RPC protocol fault. Do NOT leak stack traces,
        // inner URLs, or exception text to the model.
        catch (Exception ex) when (ex is HttpRequestException or JsonException)
        {
            return Error($"{tool} failed: upstream unavailable");
        }
        // Catch-all: a mapping defect (e.g. a 200 with a well-formed JSON body whose
        // shape leaves a required collection/member null, NRE-ing the LINQ projection)
        // must NOT escape as an opaque JSON-RPC -32603 protocol fault. Keep the
        // protocol stream intact and return a clean, non-leaking tool error.
        // EXCLUDES OperationCanceledException so genuine caller cancellation (token
        // IS cancelled) still propagates and the SDK ends the call cooperatively.
        //
        // The one branch that is OUR bug rather than the upstream's or the caller's, so it is
        // logged at Error — which is what reaches Sentry in http mode. Until it was, a broken
        // mapping looked to the owner exactly like a quiet day. The template names the tool and
        // nothing else: the arguments are the reader's text, and stay out of the log.
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "MCP tool {Tool} failed with an unexpected error", tool);
            return Error($"{tool} failed: unexpected error");
        }
    }

    // ── my library: search_my_library / get_my_book ─────────────────────────────
    //
    // The user's own books, identified by `bookId`. Bearer-scoped: the endpoints filter by user, so the
    // bridge inherits the app's isolation rather than reimplementing it.

    private static readonly JsonElement SearchMyLibrarySchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "query": { "type": "string", "minLength": 2, "maxLength": 200 },
            "tags": { "type": "string", "maxLength": 200 }
          },
          "required": ["query"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildSearchMyLibrary(TextStackApiClient api) => new()
    {
        Name = "search_my_library",
        Title = "Search my uploaded books",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("search_my_library"),
        InputSchema = SearchMyLibrarySchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "query", "tags")
                || !ArgReader.TryRequiredString(obj, "query", 2, 200, out var query, out err)
                || !ArgReader.TryOptionalString(obj, "tags", 200, out var tags, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("search_my_library", ct, async () =>
            {
                var hits = await api.SearchMyLibraryAsync(query, tags, ct);
                var results = hits.Select(h => new
                {
                    // Stated on every row so a model holding a mixed result set
                    // cannot lose track of which id space an id came from.
                    source = "userbook",
                    bookId = h.Id,
                    title = h.Title,
                    author = h.Author ?? "",
                    language = h.Language,
                    chapterSlug = h.ChapterSlug,
                    excerpt = h.Excerpt ?? "",
                });
                return Text(JsonSerializer.Serialize(new { results }));
            });
        },
    };

    private static readonly JsonElement GetMyBookSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildGetMyBook(TextStackApiClient api) => new()
    {
        Name = "get_my_book",
        Title = "Get one of my uploaded books",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("get_my_book"),
        InputSchema = GetMyBookSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("get_my_book", ct, async () =>
            {
                var book = await api.GetMyBookAsync(bookId, ct);
                if (book is null)
                    return Error($"get_my_book: no uploaded book found with id '{bookId}'");

                var mapped = new
                {
                    source = "userbook",
                    bookId = book.Id,
                    title = book.Title,
                    slug = book.Slug,
                    language = book.Language,
                    author = book.Author ?? "",
                    description = book.Description ?? "",
                    genre = book.Genre,
                    publishedYear = book.PublishedYear,
                    // Half the uploaded library is PDF, and a PDF is read as the
                    // original document (ADR-012), where a highlight is painted from
                    // page geometry. A highlight written from here carries a text
                    // quote instead, so on these books it is saved and listable but
                    // does not appear over the page. Say so where the model can act
                    // on it rather than letting it discover the gap by not seeing one.
                    rendersAsOriginalPdf = book.HasOriginalPdf,
                    // The table of contents only (ADR-033): no chapter text here, and an empty list says why.
                    chapters = (book.Chapters ?? []).Select(c => new
                    {
                        chapterId = c.Id,
                        chapterNumber = c.ChapterNumber,
                        slug = c.Slug,
                        title = c.Title,
                    }),
                    note = book.Chapters is { Count: > 0 } ? ShareToRead : NoTocYet,
                };
                return Text(JsonSerializer.Serialize(mapped));
            });
        },
    };

    private const string ShareToRead =
        "Chapter text is not available here. To discuss a chapter's text, ask the user to share it from the TextStack "
        + "reader (\"Discuss this chapter\"), then read it with get_shared_chapter.";

    private const string NoTocYet =
        "No chapters yet: ask the user to open the book once in the TextStack reader, which lists its chapters.";

    // ── list_my_vocabulary ──────────────────────────────────────────────────────

    private static readonly JsonElement ListMyVocabularySchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "stage": { "type": "integer", "minimum": 0, "maximum": 4 },
            "search": { "type": "string", "maxLength": 100 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
            "offset": { "type": "integer", "minimum": 0 }
          },
          "required": [],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildListMyVocabulary(TextStackApiClient api) => new()
    {
        Name = "list_my_vocabulary",
        Title = "List my vocabulary",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("list_my_vocabulary"),
        InputSchema = ListMyVocabularySchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "stage", "search", "limit", "offset")
                || !ArgReader.TryOptionalInt(obj, "stage", 0, 4, out var stage, out err)
                || !ArgReader.TryOptionalString(obj, "search", 100, out var search, out err)
                || !ArgReader.TryOptionalInt(obj, "limit", 1, 100, out var limit, out err)
                || !ArgReader.TryOptionalInt(obj, "offset", 0, int.MaxValue, out var offset, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("list_my_vocabulary", ct, async () =>
            {
                var listed = await api.GetVocabularyAsync(stage, search, limit, offset, ct);
                if (Refused("list_my_vocabulary", listed) is { } refused) return refused;
                var page = listed.Value!;
                var items = page.Items.Select(w => new
                {
                    // What update_vocabulary_word / delete_vocabulary_word take.
                    id = w.Id,
                    word = w.Word,
                    language = w.Language,
                    translation = w.Translation,
                    definition = w.Definition,
                    stage = w.Stage,
                    bookTitle = w.BookTitle,
                    nextReviewAt = w.NextReviewAt,
                });
                return Text(JsonSerializer.Serialize(new { total = page.Total, items }));
            });
        },
    };

    // ── vocabulary writes: add_vocabulary_words / update_vocabulary_word / delete_vocabulary_word ──
    // Each is the app's own endpoint; the server decides the bucket (SRS, pending, lookup) exactly as
    // for a tap in the reader, and each outcome is relayed in fixed words the model can act on.

    private const int MaxWordsPerBatch = 20;

    private static readonly JsonElement AddVocabularyWordsSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "words": {
              "type": "array", "minItems": 1, "maxItems": 20,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["word", "language"],
                "properties": {
                  "word": { "type": "string", "minLength": 1, "maxLength": 200 },
                  "language": { "type": "string", "minLength": 2, "maxLength": 8 },
                  "translation": { "type": "string", "maxLength": 500 },
                  "definition": { "type": "string", "maxLength": 1000 },
                  "sentence": { "type": "string", "maxLength": 1000 }
                }
              }
            },
            "bookId": { "type": "string", "format": "uuid" },
            "bookTitle": { "type": "string", "maxLength": 300 },
            "operationId": { "type": "string", "format": "uuid" }
          },
          "required": ["words", "operationId"],
          "additionalProperties": false
        }
        """).RootElement;

    // Nulls dropped so each result line carries only what applies to its outcome. (Not built from
    // UnescapedJson: that field is declared further down, so it is still null when this one runs.)
    private static readonly JsonSerializerOptions WordResultJson = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private McpToolDescriptor BuildAddVocabularyWords(TextStackApiClient api) => new()
    {
        Name = "add_vocabulary_words",
        Title = "Add words to my vocabulary",
        ReadOnly = false,
        Destructive = false,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("add_vocabulary_words"),
        InputSchema = AddVocabularyWordsSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "words", "bookId", "bookTitle", "operationId")
                || !ArgReader.TryOptionalGuid(obj, "operationId", out var operationId, out err)
                || !ArgReader.TryOptionalGuid(obj, "bookId", out var bookId, out err)
                || !ArgReader.TryOptionalString(obj, "bookTitle", 300, out var bookTitle, out err)
                || !TryReadWords(obj, bookId, bookTitle, out var words, out err))
                return Task.FromResult(Error(err));

            // Owner decision 13: required, so a retry never saves twice.
            if (operationId is null)
                return Task.FromResult(Error("'operationId' is required: a new UUID for this save, the same one when retrying it."));

            return InvokeAsync("add_vocabulary_words", ct, async () =>
            {
                var results = new List<WordResult>(words.Count);
                for (var i = 0; i < words.Count; i++)
                {
                    var result = await api.SaveWordAsync(words[i], operationId.Value, ct);
                    // A 429 is about the user, not the word: every later word would get the same answer.
                    if (result.Status is System.Net.HttpStatusCode.TooManyRequests)
                    {
                        results.Add(new WordResult(words[i].Word, "stopped",
                            Message: "stopped: vocabulary full (5000) or adding too fast; tell the user"));
                        results.AddRange(words.Skip(i + 1).Select(w =>
                            new WordResult(w.Word, "not_attempted", Message: "not attempted; the batch stopped")));
                        break;
                    }
                    results.Add(ToWordResult(words[i].Word, result));
                }
                return Text(JsonSerializer.Serialize(new { results }, WordResultJson));
            });
        },
    };

    private sealed record WordResult(string Word, string Status, Guid? Id = null, string? Translation = null, string? Message = null);

    private static WordResult ToWordResult(string word, ApiResult<JsonElement> result)
    {
        if (result.Error is { } e)
            return new(word, "refused", Message: e);

        var body = result.Value;
        var outcome = body.TryGetProperty("outcome", out var o) ? o.GetString() ?? "" : "";
        Guid? id = null;
        string? translation = null;
        if (body.TryGetProperty("word", out var w) && w.ValueKind == JsonValueKind.Object)
        {
            if (w.TryGetProperty("id", out var idEl) && idEl.TryGetGuid(out var g)) id = g;
            if (w.TryGetProperty("translation", out var t) && t.ValueKind == JsonValueKind.String) translation = t.GetString();
        }

        return outcome switch
        {
            "srs" => new(word, outcome, id, translation, "added; first review today"),
            "already_saved" => new(word, outcome, id, translation,
                $"already in vocabulary (current translation {translation ?? "none"}); use update_vocabulary_word"),
            _ => new(word, outcome, Message: outcome),
        };
    }

    // The words array, checked item by item before any HTTP call: one bad item refuses the whole
    // batch, so the model fixes it and resends rather than half a batch landing.
    private static bool TryReadWords(
        JsonElement obj, Guid? bookId, string? bookTitle,
        out List<SaveWordJson> words, out string error)
    {
        words = [];
        error = "";
        if (!obj.TryGetProperty("words", out var arr) || arr.ValueKind != JsonValueKind.Array)
        {
            error = "'words' is required and must be an array.";
            return false;
        }

        var count = arr.GetArrayLength();
        if (count < 1 || count > MaxWordsPerBatch)
        {
            error = $"'words' must hold between 1 and {MaxWordsPerBatch} items.";
            return false;
        }

        var i = 0;
        foreach (var item in arr.EnumerateArray())
        {
            if (!ArgReader.TryObject(item, out var w, out error, "word", "language", "translation", "definition", "sentence")
                || !ArgReader.TryRequiredString(w, "word", 1, 200, out var word, out error)
                || !ArgReader.TryRequiredString(w, "language", 2, 8, out var language, out error)
                || !ArgReader.TryOptionalString(w, "translation", 500, out var translation, out error)
                || !ArgReader.TryOptionalString(w, "definition", 1000, out var definition, out error)
                || !ArgReader.TryOptionalString(w, "sentence", 1000, out var sentence, out error))
            {
                error = $"words[{i}]: {error}";
                return false;
            }

            // The review card needs a prompt; nothing fills one in after save since the dictionary went (#685).
            if (string.IsNullOrWhiteSpace(translation) && string.IsNullOrWhiteSpace(definition))
            {
                error = $"words[{i}]: needs a translation (reader's native language) or a definition (when it is the same language as the word).";
                return false;
            }

            words.Add(new SaveWordJson(word, language, translation, definition, bookId, sentence, bookTitle));
            i++;
        }

        return true;
    }

    private static readonly JsonElement UpdateVocabularyWordSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "id": { "type": "string", "format": "uuid" },
            "translation": { "type": "string", "minLength": 1, "maxLength": 500 },
            "definition": { "type": "string", "maxLength": 1000 }
          },
          "required": ["id"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildUpdateVocabularyWord(TextStackApiClient api) => new()
    {
        Name = "update_vocabulary_word",
        Title = "Edit a vocabulary word",
        ReadOnly = false,
        Destructive = true,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("update_vocabulary_word"),
        InputSchema = UpdateVocabularyWordSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "id", "translation", "definition")
                || !ArgReader.TryRequiredGuid(obj, "id", out var id, out err)
                || !ArgReader.TryOptionalString(obj, "translation", 500, out var translation, out err)
                || !ArgReader.TryOptionalString(obj, "definition", 1000, out var definition, out err))
                return Task.FromResult(Error(err));

            if (translation is null && definition is null)
                return Task.FromResult(Error("Pass at least one of 'translation' or 'definition'."));
            if (translation is { Length: 0 })
                return Task.FromResult(Error("'translation' must not be empty."));

            return InvokeAsync("update_vocabulary_word", ct, async () =>
            {
                var result = await api.UpdateWordAsync(id, translation, definition, ct);
                if (result.Status is System.Net.HttpStatusCode.NotFound)
                    return Error("update_vocabulary_word: no such word; get ids from list_my_vocabulary");
                if (Refused("update_vocabulary_word", result) is { } refused) return refused;

                var w = result.Value;
                return Text(JsonSerializer.Serialize(new
                {
                    id,
                    word = w.TryGetProperty("word", out var word) ? word.GetString() : null,
                    translation = w.TryGetProperty("translation", out var t) ? t.GetString() : null,
                    definition = w.TryGetProperty("definition", out var d) ? d.GetString() : null,
                    updated = true,
                }, UnescapedJson));
            });
        },
    };

    /// <summary>One required <c>id</c> (UUID): the delete tools' input.</summary>
    private static readonly JsonElement IdOnlySchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "id": { "type": "string", "format": "uuid" }
          },
          "required": ["id"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildDeleteVocabularyWord(TextStackApiClient api) => new()
    {
        Name = "delete_vocabulary_word",
        Title = "Delete a vocabulary word",
        ReadOnly = false,
        Destructive = true,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("delete_vocabulary_word"),
        InputSchema = IdOnlySchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "id")
                || !ArgReader.TryRequiredGuid(obj, "id", out var id, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("delete_vocabulary_word", ct, async () =>
            {
                var result = await api.DeleteWordAsync(id, ct);
                if (result.Status is System.Net.HttpStatusCode.NotFound)
                    return Error("delete_vocabulary_word: no such word; get ids from list_my_vocabulary");
                return Refused("delete_vocabulary_word", result) ?? Text(JsonSerializer.Serialize(new { id, deleted = true }));
            });
        },
    };

    // Match the web reader's HighlightColor palette (offlineDb.ts) — no "orange".
    private static readonly string[] HighlightColors = ["yellow", "green", "blue", "pink"];

    // ── write-back: highlights and insights on the user's OWN books ─────────────
    //
    // This is the half that makes the whole surface worth having. The reasoning
    // happens in the client — Claude, ChatGPT, wherever the reader already has a
    // profile and a year of history. What comes back here is the RESULT, attached
    // to the book so it is still there next month.
    //
    // Two shapes, because a conclusion is not always about one passage:
    //   • a passage       → a highlight, which the reader already paints;
    //   • a chapter, or   → an insight keyed by chapter slug;
    //   • the whole book  → an insight with no chapter slug.
    // A study summary is the assembly of those in reading order, not a separate
    // document — so re-running a pass refreshes it instead of duplicating it.

    private static readonly JsonElement SaveMyHighlightSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterId": { "type": "string", "format": "uuid" },
            "selectedText": { "type": "string", "minLength": 1, "maxLength": 5000 },
            "color": { "type": "string", "enum": ["yellow", "green", "blue", "pink"] },
            "noteText": { "type": "string", "maxLength": 2000 }
          },
          "required": ["bookId", "chapterId", "selectedText"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildSaveMyHighlight(TextStackApiClient api) => new()
    {
        Name = "save_my_highlight",
        Title = "Save a highlight in my uploaded book",
        ReadOnly = false,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("save_my_highlight"),
        InputSchema = SaveMyHighlightSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "chapterId", "selectedText", "color", "noteText")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err)
                || !ArgReader.TryRequiredGuid(obj, "chapterId", out var chapterId, out err)
                || !ArgReader.TryRequiredString(obj, "selectedText", 1, 5000, out var selectedText, out err)
                || !ArgReader.TryOptionalString(obj, "noteText", 2000, out var noteText, out err)
                || !TryReadColor(obj, out var color, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("save_my_highlight", ct, async () =>
            {
                var saved = await api.SaveUserBookHighlightAsync(bookId, chapterId, color, selectedText, noteText, ct);
                if (saved is null)
                    return Error("save_my_highlight failed: the book or chapter was not found, or the save was rejected");

                var mapped = new
                {
                    id = saved.Id,
                    source = "userbook",
                    bookId,
                    chapterId = saved.ChapterId ?? chapterId,
                    color = saved.Color,
                    selectedText = saved.SelectedText,
                    noteText = saved.NoteText,
                    createdAt = saved.CreatedAt,
                    saved = true,
                };
                return Text(JsonSerializer.Serialize(mapped));
            });
        },
    };

    private static readonly JsonElement ListMyBookHighlightsSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildListMyBookHighlights(TextStackApiClient api) => new()
    {
        Name = "list_my_book_highlights",
        Title = "List highlights in my uploaded book",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("list_my_book_highlights"),
        InputSchema = ListMyBookHighlightsSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("list_my_book_highlights", ct, async () =>
            {
                var highlights = await api.GetUserBookHighlightsAsync(bookId, ct);
                if (highlights is null)
                    return Error($"list_my_book_highlights: no uploaded book found with id '{bookId}'");

                var mapped = highlights.Select(h => new
                {
                    id = h.Id,
                    // An upload's chapter arrives as userChapterId; report it under the name the
                    // write tool takes, so listing and saving speak about the same thing.
                    chapterId = h.UserChapterId ?? h.ChapterId,
                    color = h.Color,
                    selectedText = h.SelectedText,
                    noteText = h.NoteText,
                    createdAt = h.CreatedAt,
                });
                return Text(JsonSerializer.Serialize(new { source = "userbook", bookId, highlights = mapped }));
            });
        },
    };

    private static readonly JsonElement SaveInsightSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterSlug": { "type": "string", "maxLength": 300 },
            "text": { "type": "string", "minLength": 1, "maxLength": 20000 },
            "question": { "type": "string", "maxLength": 1000 }
          },
          "required": ["bookId", "text"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildSaveInsight(TextStackApiClient api) => new()
    {
        Name = "save_insight",
        Title = "Save an insight",
        ReadOnly = false,
        Destructive = true,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("save_insight"),
        InputSchema = SaveInsightSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "chapterSlug", "text", "question")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var id, out err)
                || !ArgReader.TryRequiredString(obj, "text", 1, 20000, out var text, out err)
                || !ArgReader.TryOptionalString(obj, "chapterSlug", 300, out var chapterSlug, out err)
                || !ArgReader.TryOptionalString(obj, "question", 1000, out var question, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("save_insight", ct, async () =>
            {
                var saved = await api.SaveInsightAsync(id, chapterSlug, text, question, ct);
                if (saved is null)
                    return Error("save_insight failed: the book was not found, that chapter slug does not exist in it, "
                        + "or the save was rejected");

                var mapped = new
                {
                    id = saved.Id,
                    bookId = saved.UserBookId,
                    chapterSlug = saved.ChapterSlug,
                    question = saved.Question,
                    updatedAt = saved.UpdatedAt,
                    saved = true,
                };
                return Text(JsonSerializer.Serialize(mapped));
            });
        },
    };

    private static readonly JsonElement GetMyInsightsSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildGetMyInsights(TextStackApiClient api) => new()
    {
        Name = "get_my_insights",
        Title = "Get my insights",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("get_my_insights"),
        InputSchema = GetMyInsightsSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var id, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("get_my_insights", ct, async () =>
            {
                var insights = await api.GetInsightsAsync(id, ct);
                if (insights is null)
                    return Error($"get_my_insights: no uploaded book found with id '{id}'");

                var mapped = insights.Select(i => new
                {
                    id = i.Id,
                    // null chapterSlug = about the whole book.
                    chapterSlug = i.ChapterSlug,
                    chapterNumber = i.ChapterNumber,
                    chapterTitle = i.ChapterTitle,
                    question = i.Question,
                    text = i.Text,
                    updatedAt = i.UpdatedAt,
                });
                return Text(JsonSerializer.Serialize(new { insights = mapped }));
            });
        },
    };

    // Re-serialized unescaped: the default encoder writes every non-ASCII character (Cyrillic, an em
    // dash, curly quotes) as \uXXXX, which bloats the model's context.
    private static readonly JsonSerializerOptions UnescapedJson = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // Optional color: absent → "yellow"; present must be one of the reader palette.
    private static bool TryReadColor(JsonElement obj, out string color, out string error)
    {
        color = "yellow";
        if (!ArgReader.TryOptionalString(obj, "color", 20, out var raw, out error))
            return false;
        if (raw is null)
            return true;
        if (Array.IndexOf(HighlightColors, raw) < 0)
        {
            error = $"'color' must be one of: {string.Join(", ", HighlightColors)}.";
            return false;
        }
        color = raw;
        return true;
    }

    // ── get_my_reading ──────────────────────────────────────────────────────────

    private static readonly JsonElement GetMyReadingSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {},
          "required": [],
          "additionalProperties": false
        }
        """).RootElement;

    /// <summary>
    /// The shelf, with no arguments. Everything else here needs an id the model does not have yet;
    /// this is the tool that gives it one, and the only answer to "what have I been reading".
    /// </summary>
    private McpToolDescriptor BuildGetMyReading(TextStackApiClient api) => new()
    {
        Name = "get_my_reading",
        Title = "Get my reading shelf",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("get_my_reading"),
        InputSchema = GetMyReadingSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out _, out var err))
                return Task.FromResult(Error(err));

            return InvokeAsync("get_my_reading", ct, async () =>
            {
                var shelves = await api.GetShelvesAsync(ct);
                // The shelves answer "right now", not "everything I have": that is the book list.
                var all = await api.GetMyBooksAsync(ct);

                var mapped = new
                {
                    reading = (shelves.ContinueReading ?? []).Select(Shelf),
                    finishedRecently = (shelves.FinishedThisMonth ?? []).Select(Shelf),
                    allBooks = all.Select(b => new
                    {
                        source = "userbook",
                        bookId = b.Id,
                        title = b.Title,
                        author = b.Author ?? "",
                        status = b.Status,
                        chapterCount = b.ChapterCount,
                        progressPercent = b.ProgressPercent,
                        chapterSlug = b.ProgressChapterSlug,
                        finishedAt = b.CompletedAt,
                    }),
                };
                return Text(JsonSerializer.Serialize(mapped));
            });
        },
    };

    private static object Shelf(ShelfItemJson i) => new
    {
        source = i.Type,
        bookId = i.Id,
        title = i.Title,
        author = i.Author ?? "",
        progressPercent = i.ProgressPercent,
        chapterSlug = i.ChapterSlug,
        lastOpenedAt = i.LastOpenedAt,
    };

    // ── get_book_progress ───────────────────────────────────────────────────────

    private static readonly JsonElement GetBookProgressSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId"],
          "additionalProperties": false
        }
        """).RootElement;

    /// <summary>
    /// Where the reader is in one book. Nothing exposed this before: the position used to leak only
    /// as <c>ask_book</c>'s spoiler refusal, which named no chapter and is now deleted.
    /// </summary>
    private McpToolDescriptor BuildGetBookProgress(TextStackApiClient api) => new()
    {
        Name = "get_book_progress",
        Title = "Get book progress",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("get_book_progress"),
        InputSchema = GetBookProgressSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var id, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("get_book_progress", ct, async () =>
            {
                var p = await api.GetUserBookProgressAsync(id, ct);
                return Text(JsonSerializer.Serialize(p is null
                    ? (object)new { source = "userbook", bookId = id, opened = false }
                    : new
                    {
                        source = "userbook",
                        bookId = id,
                        opened = true,
                        chapterSlug = p.ChapterSlug,
                        progressPercent = p.Percent,
                        lastReadAt = p.UpdatedAt,
                    }));
            });
        },
    };

    // ── set_book_progress ───────────────────────────────────────────────────────

    private static readonly JsonElement SetBookProgressSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterSlug": { "type": "string", "minLength": 1, "maxLength": 300 }
          },
          "required": ["bookId", "chapterSlug"],
          "additionalProperties": false
        }
        """).RootElement;

    /// <summary>
    /// Record that the reader finished a chapter somewhere else — an audiobook, paper, another app.
    /// The position lives here whether or not the reading did.
    /// </summary>
    private McpToolDescriptor BuildSetBookProgress(TextStackApiClient api) => new()
    {
        Name = "set_book_progress",
        Title = "Mark a chapter finished",
        ReadOnly = false,
        Destructive = true,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("set_book_progress"),
        InputSchema = SetBookProgressSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "chapterSlug")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var id, out err)
                || !ArgReader.TryRequiredString(obj, "chapterSlug", 1, 300, out var chapterSlug, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("set_book_progress", ct, async () =>
            {
                var book = await api.GetMyBookAsync(id, ct);
                if (book is null) return Error($"set_book_progress failed: no uploaded book '{id}'");

                var chapters = book.Chapters ?? [];
                if (chapters.Count == 0)
                    return Error($"set_book_progress failed: '{book.Title}' has no table of contents from the reader yet; {NoTocYet}");
                var at = IndexOfChapter(chapters.Select(c => c.Slug), chapterSlug);
                if (at < 0)
                    return Error($"set_book_progress failed: no chapter '{chapterSlug}' in '{book.Title}'; get_my_book lists its chapter slugs");

                var (resumeAt, percent, finished) = AfterFinishing(chapters, at);
                var resumeSlug = chapters[resumeAt].Slug;
                var ok = await api.SetUserBookProgressAsync(id, resumeSlug, percent, ct);

                return ok
                    ? Text(JsonSerializer.Serialize(new
                    {
                        bookId = id,
                        finishedChapterSlug = chapterSlug,
                        resumeChapterSlug = resumeSlug,
                        progressPercent = percent,
                        bookFinished = finished,
                        saved = true,
                    }))
                    : Error("set_book_progress failed: the position was refused");
            });
        },
    };

    private static int IndexOfChapter(IEnumerable<string?> slugs, string wanted)
    {
        var i = 0;
        foreach (var slug in slugs)
        {
            if (string.Equals(slug, wanted, StringComparison.Ordinal)) return i;
            i++;
        }
        return -1;
    }

    /// <summary>
    /// Where the reader is once they have finished chapter <paramref name="at"/>: the START of the
    /// next one, because "I finished chapter 2" means the app should open chapter 3 — not drop them
    /// back into what they just finished. The next one is the next TOC entry no deeper than this one,
    /// so finishing a part skips that part's own chapters. With none left there is nowhere forward to
    /// go, so the position stays and the book is simply complete.
    ///
    /// <para>The percentage is that entry's TOC fraction (ADR-033): where it starts in the book, as the
    /// reader measures it, so the app and the assistant agree on how far in the reader is (#1515).</para>
    /// </summary>
    private static (int ResumeIndex, double Percent, bool Finished) AfterFinishing(IReadOnlyList<UserChapterSummaryJson> chapters, int at)
    {
        for (var next = at + 1; next < chapters.Count; next++)
            if (chapters[next].Depth <= chapters[at].Depth)
                return (next, (double)chapters[next].Fraction, false);
        return (at, 1, true);
    }

    // ── MCP result helpers ──────────────────────────────────────────────────────

    private static CallToolResult Text(string text) => new()
    {
        Content = [new TextContentBlock { Text = text }],
    };

    private static CallToolResult Error(string message) => new()
    {
        IsError = true,
        Content = [new TextContentBlock { Text = message }],
    };

    /// <summary>
    /// Null on success. A V2 <c>book_not_found</c> names <paramref name="bookId"/>; any other refusal
    /// relays the server's message (a bare 404, the V2 API off, reads "upstream answered 404").
    /// </summary>
    private static CallToolResult? Refused<T>(string tool, ApiResult<T> result, Guid? bookId = null) =>
        result.Error is not { } message ? null
        : result.Code == "book_not_found" && bookId is { } id ? Error($"{tool}: no uploaded book found with id '{id}'")
        : Error($"{tool} refused: {message}");
}
