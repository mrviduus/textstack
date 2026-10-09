using System.Text.Json;
using Api.Extensions;
using Api.Mapping;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Application.ReadingTracking;
using Application.Vocabulary;
using TextStack.Vocabulary;
using TextStack.Vocabulary.Contracts;

namespace Api.Endpoints;

/// <summary>
/// Vocabulary HTTP surface. Routes registered via <see cref="MapVocabularyEndpoints"/>;
/// handlers are split across partial files by sub-domain to keep each
/// file under ~300 LOC and reviewable in isolation:
///
///   - VocabularyEndpoints.Stats.cs     GetStats, GetDailyStats, ParseTzOffset
///   - VocabularyEndpoints.Settings.cs  GetSettings, UpdateSettings, UnretireWord
///   - VocabularyEndpoints.Pending.cs   GetPending, PromotePending, DismissPending
///   - VocabularyEndpoints.Lookups.cs   GetLookups, PromoteLookup, DismissLookup
///   - VocabularyEndpoints.Clusters.cs  GetClusters, StartClusterBonus, DismissCluster, CompleteCluster
///
/// Everything else (SaveWord + Words CRUD + Review + helpers + DTOs)
/// stays in this file. Splits use C# `partial` — compile-identical to
/// the original monolithic file. Shared helpers (TryGetAuth, ToDto,
/// UpsertLookupAsync, FindUserWordAsync, QueueEnrichment) live here.
/// </summary>
public static partial class VocabularyEndpoints
{
    private const int MaxWordsPerUser = 5000;
    private const int MaxDistractorPoolSize = 200;

    public static void MapVocabularyEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/vocabulary").WithTags("Vocabulary");

        // Word writes share `highlight-write` (per user, 120/min): an MCP assistant writes from the
        // bridge's one container address, so only a per-user key is fair.
        group.MapPost("/words", SaveWord).WithName("SaveVocabularyWord")
            .RequireRateLimiting("highlight-write");
        group.MapGet("/words", GetWords).WithName("GetVocabularyWords");
        group.MapDelete("/words/{id:guid}", DeleteWord).WithName("DeleteVocabularyWord")
            .RequireRateLimiting("highlight-write");
        // Wiping the whole vocabulary is the reader's call, never an assistant's.
        group.MapDelete("/words", DeleteAllWords).WithName("DeleteAllVocabularyWords")
            .RejectOAuthTokens();
        group.MapPatch("/words/{id:guid}", UpdateWord).WithName("UpdateVocabularyWord")
            .RequireRateLimiting("highlight-write");
        group.MapGet("/review", GetReviewQueue).WithName("GetVocabularyReview");
        group.MapPost("/review", SubmitReview).WithName("SubmitVocabularyReview");
        group.MapGet("/stats", GetStats).WithName("GetVocabularyStats");
        group.MapGet("/stats/daily", GetDailyStats).WithName("GetDailyVocabularyStats");
        group.MapGet("/words/reader", GetReaderVocab).WithName("GetReaderVocabulary");
        group.MapPut("/words/{id:guid}/known", MarkAsKnown).WithName("MarkVocabularyWordKnown");

        // Anti-spiral settings + unretire (Phase 1)
        group.MapGet("/settings", GetSettings).WithName("GetVocabularySettings");
        group.MapPut("/settings", UpdateSettings).WithName("UpdateVocabularySettings");
        group.MapPost("/words/{id:guid}/unretire", UnretireWord).WithName("UnretireVocabularyWord");

        // Anti-spiral pending buffer (Phase 2)
        group.MapGet("/pending", GetPending).WithName("GetPendingVocabularyWords");
        group.MapPost("/pending/{id:guid}/promote", PromotePending).WithName("PromotePendingVocabularyWord");
        group.MapDelete("/pending/{id:guid}", DismissPending).WithName("DismissPendingVocabularyWord");

        // Anti-spiral lookups bucket (Phase 3 F1)
        group.MapGet("/lookups", GetLookups).WithName("GetWordLookups");
        group.MapPost("/lookups/{id:guid}/promote", PromoteLookup).WithName("PromoteWordLookup");
        group.MapDelete("/lookups/{id:guid}", DismissLookup).WithName("DismissWordLookup");

        // Anti-spiral thematic clusters bonus round (Phase 4 F3)
        group.MapGet("/clusters", GetClusters).WithName("GetWordClusters");
        group.MapPost("/clusters/{id:guid}/start-bonus", StartClusterBonus).WithName("StartClusterBonus");
        group.MapPost("/clusters/{id:guid}/dismiss", DismissCluster).WithName("DismissCluster");
        group.MapPost("/clusters/{id:guid}/complete", CompleteCluster).WithName("CompleteCluster");

        // AI-060: read-only semantic concept clusters for the StatsPage widget
        group.MapGet("/concepts", GetConcepts).WithName("GetVocabularyConcepts");
    }

    // --- Save Word ---

    internal static async Task<IResult> SaveWord(
        [FromBody] SaveWordRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        DailyCapService dailyCap,
        IFrequencyFilter frequencyFilter,
        IServiceScopeFactory scopeFactory,
        ILogger<IAppDbContext> logger,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Word) || request.Word.Length > 200)
            return Results.BadRequest("Word is required (max 200 chars)");
        if (string.IsNullOrWhiteSpace(request.Language) || request.Language.Length > 8)
            return Results.BadRequest("Language is required");
        if (TooLong(request.Translation, request.Definition, request.Sentence, request.BookTitle) is { } tooLong)
            return Results.BadRequest(tooLong);
        // Reject saves without a native language — enrichment (LLM distractors,
        // hint, explanation) silently falls back to book language when native is
        // null, producing explanations in the wrong language. Frontend gates
        // this at WordPopup; this check defends against direct API calls and
        // older clients still sending `undefined`. A caller that sends none (an MCP
        // assistant) falls back to the profile's native language.
        var nativeLanguage = request.NativeLanguage;
        if (string.IsNullOrWhiteSpace(nativeLanguage))
            nativeLanguage = await db.Users
                .Where(u => u.Id == userId)
                .Select(u => u.NativeLanguage)
                .FirstOrDefaultAsync(ct);
        if (string.IsNullOrWhiteSpace(nativeLanguage))
            return Results.BadRequest(new { error = "native_language_required" });

        // Server-side, so no client can claim it: a connect key / OAuth token marks an assistant write.
        var source = httpContext.Items.ContainsKey(Middleware.McpKeyAuthMiddleware.UserIdItemKey) ? "mcp" : "tap";

        var word = request.Word.Trim().ToLowerInvariant();

        // Dedup: SRS table first, then pending buffer. A word in either bucket
        // is "already saved" from the user's perspective — don't double-insert.
        if (await FindAlreadySavedAsync(db, userId, word, request.Language, ct) is { } already)
            return already;

        // Hard ceiling — counts all three buckets. Keeps one user from bloating
        // any of them past the vocabulary cap.
        var count = await CountAllBucketsAsync(db, userId, ct);
        if (count >= MaxWordsPerUser)
            return Results.Problem("Vocabulary limit reached (5000 words)", statusCode: 429);

        var now = DateTimeOffset.UtcNow;

        // Anti-spiral F1: frequency gate. Rare/OOV words go to WordLookup and
        // never touch SRS. Mid-tier words need 2 taps before joining SRS. The
        // user's FrequencyFilterEnabled setting lets them opt out entirely.
        // Default OFF when the user has no settings row — matches the entity
        // default. Every tapped word goes straight to SRS unless the user has
        // explicitly turned the frequency filter back on.
        var filterEnabled = await db.UserVocabularySettings
            .Where(s => s.UserId == userId)
            .Select(s => (bool?)s.FrequencyFilterEnabled)
            .FirstOrDefaultAsync(ct) ?? false;

        // Query unconditionally so a user who flips the filter off doesn't leave
        // orphan lookups behind when the same word is next saved to SRS.
        var existingLookup = await db.WordLookups
            .FirstOrDefaultAsync(l => l.UserId == userId && l.Word == word && l.Language == request.Language, ct);

        int? zipfRank = null;
        double? zipfScore = null;

        if (filterEnabled)
        {
            var currentTaps = existingLookup?.TapCount ?? 0;
            var classification = await frequencyFilter.ClassifyAsync(word, request.Language, currentTaps, ct);
            zipfRank = classification.ZipfRank;
            zipfScore = classification.ZipfScore;

            if (classification.Kind == FrequencyClassKind.LookupOnly)
            {
                var lookup = await UpsertLookupAsync(db, userId, siteId, word, request, zipfRank, now, existingLookup, ct);
                await db.SaveChangesAsync(ct);
                return Results.Ok(SaveWordResponse.Lookup(lookup.Id, classification.Reason ?? "rare_word"));
            }

            if (classification.Kind == FrequencyClassKind.RequiresRetap)
            {
                var lookup = await UpsertLookupAsync(db, userId, siteId, word, request, zipfRank, now, existingLookup, ct);
                await db.SaveChangesAsync(ct);
                var tapsRemaining = Math.Max(0, classification.RequiredTaps - lookup.TapCount);
                return Results.Ok(SaveWordResponse.LookupPending(lookup.Id, tapsRemaining));
            }
            // SrsEligible falls through — lookup cleanup below covers the "was
            // mid-tier, now being promoted to SRS" case.
        }

        // Any path that creates a SRS or Pending row also drops any lingering
        // Lookup — the word isn't reference-only anymore.
        if (existingLookup != null)
            db.WordLookups.Remove(existingLookup);

        // Anti-spiral F2: daily cap on *new* SRS activations. Over-cap goes
        // to pending; reconciler promotes the highest-Priority rows tomorrow.
        var capStatus = await dailyCap.GetStatusAsync(userId, siteId, ct);
        if (capStatus.Remaining <= 0)
        {
            var pending = new PendingVocabularyWord
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                SiteId = siteId,
                Word = word,
                Language = request.Language,
                Translation = request.Translation?.Trim(),
                Definition = request.Definition?.Trim(),
                EditionId = request.EditionId,
                ChapterId = request.ChapterId,
                UserBookId = request.UserBookId,
                Sentence = request.Sentence?.Trim(),
                BookTitle = request.BookTitle?.Trim(),
                ZipfRank = zipfRank,
                ZipfScore = zipfScore,
                Source = source,
                CreatedAt = now,
            };
            db.PendingVocabularyWords.Add(pending);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsLostSaveRace(ex))
            {
                db.PendingVocabularyWords.Remove(pending);
                if (await FindAlreadySavedAsync(db, userId, word, request.Language, ct) is { } winner)
                    return winner;
                throw;
            }
            return Results.Ok(SaveWordResponse.Pending(pending.Id, reason: "daily_cap"));
        }

        var entry = new VocabularyWord
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            SiteId = siteId,
            Word = word,
            Language = request.Language,
            Translation = request.Translation?.Trim(),
            Definition = request.Definition?.Trim(),
            EditionId = request.EditionId,
            ChapterId = request.ChapterId,
            UserBookId = request.UserBookId,
            Sentence = request.Sentence?.Trim(),
            BookTitle = request.BookTitle?.Trim(),
            ZipfRank = zipfRank,
            ZipfScore = zipfScore,
            Source = source,
            ActivatedAt = now,  // F2: marks this row as counting toward today's cap.
            Stage = 0,
            IntervalDays = 0,
            ConsecutiveCorrect = 0,
            NextReviewAt = now,
            TotalReviews = 0,
            CorrectReviews = 0,
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.VocabularyWords.Add(entry);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsLostSaveRace(ex))
        {
            // Lost a double-submit race: the other request inserted this word between our dedup
            // read and this insert. Answer as the dedup path would, and skip enrichment (the
            // winner queued it).
            db.VocabularyWords.Remove(entry);
            if (await FindAlreadySavedAsync(db, userId, word, request.Language, ct) is { } winner)
                return winner;
            throw;
        }

        QueueEnrichment(scopeFactory, logger, entry.Id, word, request.Language,
            request.Definition, request.Sentence, nativeLanguage);

        return Results.Ok(SaveWordResponse.Srs(ToDto(entry)));
    }

    /// <summary>
    /// The column limits every vocabulary bucket shares (<c>AppDbContext.Vocabulary.cs</c>), checked on
    /// the trimmed value that is stored. Over them Postgres raised 22001 and the save answered 500.
    /// </summary>
    internal static string? TooLong(
        string? translation, string? definition, string? sentence = null, string? bookTitle = null)
    {
        return Over(translation, 500, "Translation") ?? Over(definition, 2000, "Definition")
            ?? Over(sentence, 1000, "Sentence") ?? Over(bookTitle, 500, "BookTitle");

        static string? Over(string? value, int max, string name) =>
            value?.Trim().Length > max ? $"{name} too long (max {max} chars)" : null;
    }

    /// <summary>
    /// How a double-submit loser's SaveChanges fails: 23505 on the insert, or — when the word had a
    /// WordLookup that both requests delete in that same save — a DELETE hitting 0 rows
    /// (<see cref="DbUpdateConcurrencyException"/>), which EF raises before the insert conflicts.
    /// The whole save rolls back either way; the caller re-reads the winner.
    /// </summary>
    private static bool IsLostSaveRace(DbUpdateException ex) =>
        ex is DbUpdateConcurrencyException || UserDataEndpoints.IsUniqueViolation(ex);

    /// <summary>
    /// The "already saved" answer for a word in the SRS table or the pending buffer, else null. Used by
    /// the dedup read and again after losing a concurrent insert (23505) — both must answer alike.
    /// </summary>
    private static async Task<IResult?> FindAlreadySavedAsync(
        IAppDbContext db, Guid userId, string word, string language, CancellationToken ct)
    {
        var existing = await db.VocabularyWords
            .FirstOrDefaultAsync(w => w.UserId == userId && w.Word == word && w.Language == language, ct);
        if (existing != null)
            return Results.Ok(SaveWordResponse.AlreadySaved(ToDto(existing)));

        var existingPending = await db.PendingVocabularyWords
            .FirstOrDefaultAsync(p => p.UserId == userId && p.Word == word && p.Language == language, ct);
        return existingPending != null ? Results.Ok(SaveWordResponse.AlreadyPending(existingPending.Id)) : null;
    }

    /// <summary>
    /// Rows this user holds across ALL THREE vocabulary buckets — active SRS, pending, and lookups —
    /// measured against <see cref="MaxWordsPerUser"/>.
    /// </summary>
    /// <remarks>
    /// WordLookups were previously outside this count, and the lookup branch of <c>SaveWord</c>
    /// returns before every cap in the method (correctly: a lookup row is free, no LLM call fires).
    /// The two together meant a session could accumulate lookup rows without limit — free per row,
    /// but a reservoir sized only by patience, and every one of them is a candidate for
    /// <c>PromoteLookup</c>. Counting them here bounds the reservoir with the limit that already
    /// exists rather than inventing a fourth number.
    /// </remarks>
    private static async Task<int> CountAllBucketsAsync(IAppDbContext db, Guid userId, CancellationToken ct)
    {
        var count = await db.VocabularyWords.CountAsync(w => w.UserId == userId, ct);
        count += await db.PendingVocabularyWords.CountAsync(p => p.UserId == userId, ct);
        count += await db.WordLookups.CountAsync(l => l.UserId == userId, ct);
        return count;
    }

    // Fire-and-forget enrichment for a just-inserted VocabularyWord. Runs in
    // its own DI scope so it outlives the request scope. Failures log but
    // don't surface — the user already got a success response.
    private static void QueueEnrichment(
        IServiceScopeFactory scopeFactory,
        ILogger logger,
        Guid wordId,
        string wordText,
        string lang,
        string? def,
        string? sent,
        string nativeLang)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var bgDb = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
                var generator = scope.ServiceProvider.GetRequiredService<IDistractorGenerator>();

                // AI-058: embed the word for semantic concept clustering. Own try/catch so an
                // embedding failure (OpenAI down/unconfigured) never drops the Ollama distractor
                // write below — and vice-versa. en-only signal (word + definition + sentence),
                // NOT Translation, to keep the embedding space monolingual.
                try
                {
                    var embedder = scope.ServiceProvider.GetRequiredService<global::TextStack.Ai.Core.IEmbeddingService>();
                    var signal = $"{wordText}. {def} {sent}".Trim();
                    var vec = await embedder.EmbedAsync(signal, CancellationToken.None);
                    var w = await bgDb.VocabularyWords.FirstOrDefaultAsync(
                        x => x.Id == wordId, CancellationToken.None);
                    if (w != null)
                    {
                        w.Embedding = vec;
                        await bgDb.SaveChangesAsync(CancellationToken.None);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Embedding failed for word {Word}", wordText);
                }

                // Generate distractors + hint + explanation via Ollama.
                var (distractors, hint, explanation) = await generator.GenerateAsync(
                    wordText, lang, def, sent, nativeLang, CancellationToken.None);
                if (distractors?.Count > 0 || hint != null || explanation != null)
                {
                    var w = await bgDb.VocabularyWords.FirstOrDefaultAsync(
                        x => x.Id == wordId, CancellationToken.None);
                    if (w != null)
                    {
                        if (distractors?.Count > 0)
                            w.Distractors = JsonSerializer.Serialize(distractors);
                        if (hint != null)
                            w.Hint = hint;
                        if (explanation != null)
                            w.Explanation = explanation;
                        await bgDb.SaveChangesAsync(CancellationToken.None);
                    }
                }
            }
            catch (HttpRequestException ex)
            {
                logger.LogWarning(ex, "Enrichment failed for word {Word}", wordText);
            }
            catch (TaskCanceledException)
            {
                logger.LogWarning("Enrichment timeout for word {WordText}", wordText);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to enrich word {Word}", wordText);
            }
        });
    }

    // --- List Words ---

    private static async Task<IResult> GetWords(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] string? stage,
        [FromQuery] string? language,
        [FromQuery] Guid? editionId,
        [FromQuery] string? search,
        [FromQuery] string? sort,
        [FromQuery] DateTimeOffset? reviewedSince,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var query = db.VocabularyWords
            .Where(w => w.UserId == userId);

        if (!string.IsNullOrEmpty(stage))
        {
            var stages = stage.Split(',')
                .Select(s => int.TryParse(s.Trim(), out var v) ? v : -1)
                .Where(v => v >= 0)
                .ToList();
            if (stages.Count > 0)
                query = query.Where(w => stages.Contains(w.Stage));
        }

        if (!string.IsNullOrEmpty(language))
            query = query.Where(w => w.Language == language);

        if (editionId.HasValue)
            query = query.Where(w => w.EditionId == editionId.Value);

        if (!string.IsNullOrEmpty(search))
        {
            var s = search.Trim().ToLowerInvariant();
            query = query.Where(w => w.Word.Contains(s) || (w.Translation != null && w.Translation.Contains(s)));
        }

        if (reviewedSince.HasValue)
            query = query.Where(w => w.LastReviewedAt != null && w.LastReviewedAt >= reviewedSince.Value);

        var total = await query.CountAsync(ct);

        query = sort switch
        {
            "alphabetical" => query.OrderBy(w => w.Word),
            "due" => query.OrderBy(w => w.NextReviewAt),
            "stage" => query.OrderByDescending(w => w.Stage).ThenByDescending(w => w.UpdatedAt),
            "lastReviewed" => query.OrderByDescending(w => w.LastReviewedAt),
            _ => query.OrderByDescending(w => w.CreatedAt),
        };

        var items = await query
            .Skip(offset ?? 0)
            .Take(Math.Min(limit ?? 50, 100))
            .Select(w => new VocabWordDto(
                w.Id, w.Word, w.Language, w.Translation, w.Definition,
                w.EditionId, w.ChapterId, w.UserBookId,
                w.Sentence, w.BookTitle, w.Hint,
                w.Stage, w.IntervalDays, w.ConsecutiveCorrect,
                w.NextReviewAt, w.LastReviewedAt,
                w.TotalReviews, w.CorrectReviews,
                w.CreatedAt, w.UpdatedAt))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    // --- Delete Word ---

    private static async Task<IResult> DeleteWord(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var word = await FindUserWordAsync(db, id, userId, siteId, ct);
        if (word == null) return Results.NotFound();

        db.VocabularyWords.Remove(word);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    // --- Delete All Words ---

    private static async Task<IResult> DeleteAllWords(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var words = await db.VocabularyWords
            .Where(w => w.UserId == userId)
            .ToListAsync(ct);

        db.VocabularyWords.RemoveRange(words);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { deleted = words.Count });
    }

    // --- Update Word ---

    private static async Task<IResult> UpdateWord(
        Guid id,
        [FromBody] UpdateWordRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var word = await FindUserWordAsync(db, id, userId, siteId, ct);
        if (word == null) return Results.NotFound();
        if (TooLong(request.Translation, request.Definition) is { } tooLong)
            return Results.BadRequest(tooLong);

        ApplyUpdate(word, request);
        word.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        return Results.Ok(ToDto(word));
    }

    // TR-2: an automatic fill (OnlyIfEmpty) never changes a saved translation; only a plain PATCH replaces it.
    internal static void ApplyUpdate(VocabularyWord word, UpdateWordRequest request)
    {
        if (request.Translation != null && !(request.OnlyIfEmpty && !string.IsNullOrWhiteSpace(word.Translation)))
            word.Translation = request.Translation.Trim();
        if (request.Definition != null) word.Definition = request.Definition.Trim();
    }

    // --- Review Queue ---

    private static async Task<IResult> GetReviewQueue(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        IReviewCardBuilder cardBuilder,
        WeeklyBudgetService weeklyBudget,
        [FromQuery] int? limit,
        [FromQuery] string? mode,
        [FromQuery] bool? includeAll,
        [FromQuery] bool? practice,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var now = DateTimeOffset.UtcNow;
        var batchSize = Math.Min(limit ?? 10, 50);
        var isPractice = practice == true;

        // Anti-spiral F5 bypass: practice mode skips the budget clamp so users
        // can drill words anytime without waiting for the 7d window to roll.
        // Practice rows never feed back into the budget (see WeeklyBudgetService).
        WeeklyProgress? weeklyProgress = isPractice
            ? null
            : await weeklyBudget.GetProgressAsync(userId, siteId, ct);
        var fetchLimit = isPractice
            ? batchSize
            : Math.Min(batchSize, weeklyProgress!.Remaining);

        // Retired rows (F4) are hidden from the queue — they already graduated.
        var baseQuery = db.VocabularyWords
            .Where(w => w.UserId == userId && !w.IsRetired);

        var totalDue = await baseQuery
            .CountAsync(w => w.NextReviewAt <= now, ct);

        var weeklyProgressDto = weeklyProgress is null ? null : ToDto(weeklyProgress);

        if (fetchLimit == 0)
            return Results.Ok(new ReviewQueueResponse([], totalDue, weeklyProgressDto));

        // SRS: return due words first. Tie-break by Priority (F5) — over-
        // budgeted days surface the highest-value words first.
        var dueWords = await baseQuery
            .Where(w => w.NextReviewAt <= now)
            .OrderBy(w => w.NextReviewAt)
            .ThenByDescending(w => w.Priority)
            .Take(fetchLimit)
            .ToListAsync(ct);

        // Practice mode wants something to drill even when nothing is due —
        // fall back to closest-to-due words (same as explicit ?includeAll=true).
        if (dueWords.Count == 0 && (includeAll == true || isPractice))
        {
            dueWords = await baseQuery
                .OrderBy(w => w.NextReviewAt)
                .ThenByDescending(w => w.Priority)
                .Take(fetchLimit)
                .ToListAsync(ct);
        }

        if (dueWords.Count == 0)
            return Results.Ok(new ReviewQueueResponse([], totalDue, weeklyProgressDto));

        // Distractor pool: other user words (capped to prevent OOM). Retired
        // words are fine as distractors — they still belong to the same pool.
        var languages = dueWords.Select(w => w.Language).Distinct().ToList();
        var dueWordIds = dueWords.Select(w => w.Id).ToHashSet();

        var distractorPool = await db.VocabularyWords
            .Where(w => w.UserId == userId && !dueWordIds.Contains(w.Id)
                && languages.Contains(w.Language))
            .OrderBy(_ => EF.Functions.Random())
            .Take(MaxDistractorPoolSize)
            .Select(VocabularyMappings.DistractorPoolProject)
            .ToListAsync(ct);

        var wordsForReview = dueWords.Select(VocabularyMappings.ToWordForReview).ToList();

        var cards = cardBuilder.BuildCards(wordsForReview, distractorPool);

        // Map to endpoint DTO
        var cardDtos = cards.Select(c => new ReviewCardDto(
            c.WordId, c.Word, c.Translation, c.Definition,
            c.ReviewMode, c.BlankSentence, c.OriginalSentence, c.BookTitle,
            c.Hint, c.Explanation, c.IsNew, c.Options, c.CorrectOptionIndex)).ToList();

        return Results.Ok(new ReviewQueueResponse(cardDtos, totalDue, weeklyProgressDto));
    }

    // --- Submit Review ---

    private static async Task<IResult> SubmitReview(
        [FromBody] SubmitReviewRequest request,
        HttpContext httpContext,
        AuthService authService,
        VocabularyReviewRecorder recorder,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        // The whole body of this handler moved to VocabularyReviewRecorder unchanged, because
        // Smart session needed the same write and had quietly grown its own path that wrote
        // nothing at all. See the recorder's doc comment.
        var result = await recorder.RecordAsync(
            userId, siteId, request.WordId, request.IsCorrect, request.ResponseTimeMs, request.IsPractice, ct);
        if (result is null) return Results.NotFound();

        return Results.Ok(new SubmitReviewResponse(
            result.WordId, result.StageBefore, result.StageAfter, result.StageBefore != result.StageAfter,
            result.IntervalDays, result.NextReviewAt, result.TotalReviews, result.CorrectReviews));
    }

    // --- Reader Vocab (lightweight word+stage list) ---

    private static async Task<IResult> GetReaderVocab(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var words = await db.VocabularyWords
            .Where(w => w.UserId == userId)
            .OrderBy(w => w.Word)
            .Take(MaxWordsPerUser)
            .Select(w => new ReaderVocabWordDto(w.Id, w.Word, w.Stage, w.Translation))
            .ToListAsync(ct);

        return Results.Ok(words);
    }

    // --- Mark word as Known (stage 4) ---

    private static async Task<IResult> MarkAsKnown(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var word = await FindUserWordAsync(db, id, userId, siteId, ct);

        if (word == null) return Results.NotFound();

        word.Stage = 4;
        word.IntervalDays = 30;
        word.NextReviewAt = DateTimeOffset.UtcNow.AddDays(30);
        word.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        return Results.Ok(ToDto(word));
    }

    // --- Shared helpers ---

    // Resolves userId + siteId from the request. Returns false when the caller
    // is unauthenticated (caller should return Results.Unauthorized). Collapses
    // the 3-line auth preamble that otherwise repeats at every endpoint.
    private static bool TryGetAuth(HttpContext ctx, AuthService authService, out Guid userId, out Guid siteId)
    {
        var uid = ctx.GetUserId(authService);
        if (uid is null) { userId = Guid.Empty; siteId = Guid.Empty; return false; }
        userId = uid.Value;
        siteId = ctx.GetSiteId();
        return true;
    }

    // Ownership-scoped lookup used by every per-word mutation endpoint.
    private static Task<VocabularyWord?> FindUserWordAsync(
        IAppDbContext db, Guid id, Guid userId, Guid siteId, CancellationToken ct)
        => db.VocabularyWords.FirstOrDefaultAsync(
            w => w.Id == id && w.UserId == userId, ct);

    private static VocabWordDto ToDto(VocabularyWord w) => new(
        w.Id, w.Word, w.Language, w.Translation, w.Definition,
        w.EditionId, w.ChapterId, w.UserBookId,
        w.Sentence, w.BookTitle, w.Hint,
        w.Stage, w.IntervalDays, w.ConsecutiveCorrect,
        w.NextReviewAt, w.LastReviewedAt,
        w.TotalReviews, w.CorrectReviews,
        w.CreatedAt, w.UpdatedAt);

    // Anti-spiral F1. Create-or-bump the WordLookup row for this tap. Sentence /
    // book context is overwritten on each tap so we always show the *latest*
    // context when the user opens the Lookups list.
    private static async Task<WordLookup> UpsertLookupAsync(
        IAppDbContext db, Guid userId, Guid siteId, string word, SaveWordRequest request,
        int? zipfRank, DateTimeOffset now, WordLookup? existing, CancellationToken ct)
    {
        if (existing != null)
        {
            existing.TapCount += 1;
            existing.LastTappedAt = now;
            existing.Sentence = request.Sentence?.Trim() ?? existing.Sentence;
            existing.BookTitle = request.BookTitle?.Trim() ?? existing.BookTitle;
            existing.EditionId = request.EditionId ?? existing.EditionId;
            existing.ChapterId = request.ChapterId ?? existing.ChapterId;
            existing.UserBookId = request.UserBookId ?? existing.UserBookId;
            existing.LastTranslation = request.Translation?.Trim() ?? existing.LastTranslation;
            existing.ZipfRank = zipfRank ?? existing.ZipfRank;
            return existing;
        }

        var lookup = new WordLookup
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            SiteId = siteId,
            Word = word,
            Language = request.Language,
            ZipfRank = zipfRank,
            TapCount = 1,
            Sentence = request.Sentence?.Trim(),
            BookTitle = request.BookTitle?.Trim(),
            EditionId = request.EditionId,
            ChapterId = request.ChapterId,
            UserBookId = request.UserBookId,
            LastTranslation = request.Translation?.Trim(),
            FirstTappedAt = now,
            LastTappedAt = now,
        };
        db.WordLookups.Add(lookup);
        return await Task.FromResult(lookup);
    }

    private static WeeklyProgressDto ToDto(WeeklyProgress p) =>
        new(p.Used, p.Budget, p.Remaining, p.ResetAt);

}

// --- DTOs ---

public record SaveWordRequest(
    string Word, string Language,
    string? Translation, string? Definition,
    Guid? EditionId, Guid? ChapterId, Guid? UserBookId,
    string? Sentence, string? BookTitle,
    string? NativeLanguage = null);

// OnlyIfEmpty (TR-2): an automatic fill writes the translation only when none is stored.
public record UpdateWordRequest(string? Translation, string? Definition, bool OnlyIfEmpty = false);

public record VocabWordDto(
    Guid Id, string Word, string Language, string? Translation, string? Definition,
    Guid? EditionId, Guid? ChapterId, Guid? UserBookId,
    string? Sentence, string? BookTitle, string? Hint,
    int Stage, double IntervalDays, int ConsecutiveCorrect,
    DateTimeOffset NextReviewAt, DateTimeOffset? LastReviewedAt,
    int TotalReviews, int CorrectReviews,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public record ReviewQueueResponse(List<ReviewCardDto> Cards, int TotalDue, WeeklyProgressDto? WeeklyProgress);

public record WeeklyProgressDto(int Used, int Budget, int Remaining, DateTimeOffset ResetAt);

public record ReviewCardDto(
    Guid WordId, string Word, string? Translation, string? Definition,
    string ReviewMode,
    string? BlankSentence, string? OriginalSentence, string? BookTitle,
    string? Hint, string? Explanation, bool IsNew,
    List<string>? Options, int? CorrectOptionIndex);

public record SubmitReviewRequest(Guid WordId, bool IsCorrect, int ResponseTimeMs, string? Mode = null, string? SelfAssessment = null, bool IsPractice = false);

public record SubmitReviewResponse(
    Guid WordId, int PreviousStage, int NewStage, bool StageChanged,
    double NextIntervalDays, DateTimeOffset NextReviewAt,
    int TotalReviews, int CorrectReviews);

public record ReaderVocabWordDto(Guid Id, string Word, int Stage, string? Translation);

public record WordClusterDto(
    Guid Id, string Title, string? Theme,
    Guid? EditionId, Guid? UserBookId, string? BookTitle,
    int MemberCount, double CohesionScore,
    bool IsConfirmed, DateTimeOffset CreatedAt);

// AI-060: concept cluster (Kind=="concept") for the StatsPage widget — Title/Theme + member words.
public record ConceptClusterDto(
    Guid Id, string Title, string? Theme,
    int MemberCount, double CohesionScore,
    IReadOnlyList<string> Words);

public record VocabSettingsDto(
    int DailyNewCap,
    int WeeklyReviewBudget,
    bool FrequencyFilterEnabled,
    bool ClusteringEnabled,
    bool AutoRetireEnabled,
    bool AutoSpeakCards = true);

// Anti-spiral F2. Outcome is discriminated-union-style; frontend branches on it
// to show the right toast/banner.
//   srs            — word landed in the active SRS queue (common/Zipf top-5k or 2x-tap)
//   pending        — daily cap reached, queued for tomorrow
//   lookup         — rare/OOV word → WordLookup, not SRS
//   lookup_pending — mid-tier word, needs one more tap before SRS (with tapsRemaining)
//   already_saved  — idempotent hit on existing VocabularyWord
public record SaveWordResponse(
    string Outcome,
    VocabWordDto? Word,
    Guid? PendingId,
    Guid? LookupId,
    int? TapsRemaining,
    string? Reason)
{
    public static SaveWordResponse Srs(VocabWordDto word) => new("srs", word, null, null, null, null);
    public static SaveWordResponse Pending(Guid pendingId, string reason) => new("pending", null, pendingId, null, null, reason);
    public static SaveWordResponse AlreadySaved(VocabWordDto word) => new("already_saved", word, null, null, null, null);
    // Re-tap of a word already in the pending bucket: surface as "pending" so
    // the client re-shows the "queued for tomorrow" toast instead of going silent.
    public static SaveWordResponse AlreadyPending(Guid pendingId) => new("pending", null, pendingId, null, null, "already_pending");
    public static SaveWordResponse Lookup(Guid lookupId, string reason) => new("lookup", null, null, lookupId, null, reason);
    public static SaveWordResponse LookupPending(Guid lookupId, int tapsRemaining) => new("lookup_pending", null, null, lookupId, tapsRemaining, "mid_tier");
}

public record PendingVocabWordDto(
    Guid Id, string Word, string Language, string? Translation, string? Definition,
    Guid? EditionId, Guid? ChapterId, Guid? UserBookId,
    string? Sentence, string? BookTitle,
    double Priority, string Source, DateTimeOffset CreatedAt);

public record PendingListResponse(List<PendingVocabWordDto> Items, int DailyUsed, int DailyCap, int DailyRemaining);

public record WordLookupDto(
    Guid Id, string Word, string Language, int? ZipfRank, int TapCount,
    string? Sentence, string? BookTitle,
    Guid? EditionId, Guid? ChapterId, Guid? UserBookId,
    string? LastTranslation, DateTimeOffset FirstTappedAt, DateTimeOffset LastTappedAt);

public record WordLookupListResponse(List<WordLookupDto> Items, int Total);
