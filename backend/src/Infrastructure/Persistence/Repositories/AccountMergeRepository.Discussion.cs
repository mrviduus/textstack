using System.Text.Json;
using System.Text.Json.Nodes;
using Application.Common;
using Application.Discussion;
using Contracts.V2;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>The merge's discussion: step 3e (insights of matched books) and the share and checkpoint hashes of step 7.</summary>
public sealed partial class AccountMergeRepository
{
    /// <summary>The insight that lost a clash, with the account book it is kept on as a checkpoint.</summary>
    private sealed class InsightLoser
    {
        public Guid Id { get; init; }
        public Guid BookId { get; init; }
        public string? ChapterSlug { get; init; }
        public string Text { get; init; } = "";
        public string? Question { get; init; }
        public string? ReviewJson { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }

    // One per (book, chapter) both hold (NULLS NOT DISTINCT, as the unique index): the older, a tie
    // the guest's. Owner decision 7: the newer stays current, the other is kept as a checkpoint.
    private const string SelectInsightLosers = """
        SELECT x.id, m.account_book AS book_id, x.chapter_slug, x.text, x.question, x.review_json, x.updated_at
        FROM book_insight g
        JOIN unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book) ON g.book_id = m.guest_book
        JOIN book_insight a ON a.user_id = @accountId AND a.book_id = m.account_book AND a.chapter_slug IS NOT DISTINCT FROM g.chapter_slug
        JOIN book_insight x ON x.user_id IN (@guestId, @accountId) AND x.id = CASE WHEN g.updated_at > a.updated_at THEN a.id ELSE g.id END
        WHERE g.user_id = @guestId
        """;

    private const string SelectQuestionsOfLosers = """
        SELECT book_insight_id, prompt, answer FROM review_question
        WHERE user_id IN (@guestId, @accountId) AND book_insight_id = ANY(@ids)
        ORDER BY block_index, created_at, id
        """;

    // The loser's id is the checkpoint's id and operation id: deterministic, so nothing can add it twice.
    private const string InsertLoserCheckpoint = """
        INSERT INTO discussion_checkpoints (id, user_id, book_id, chapter_key, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256, created_at)
        VALUES (@Id, @accountId, @BookId, @ChapterKey, @Topic, CAST(@ReaderThoughts AS jsonb), CAST(@AssistantSuggestions AS jsonb),
                CAST(@Conclusions AS jsonb), CAST(@OpenQuestions AS jsonb), @Language, @OperationId, @PayloadSha256, @CreatedAt)
        """;

    // After its checkpoint holds its text: its review questions go with it (cascade).
    private const string DeleteLosers = "DELETE FROM book_insight WHERE user_id IN (@guestId, @accountId) AND id = ANY(@ids)";

    // Winners and insights with no clash; their review questions follow by (user_id, book_insight_id).
    private const string MoveInsightsToAccountBooks = """
        UPDATE book_insight i SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE i.user_id = @guestId AND i.book_id = m.guest_book
        """;

    /// <summary>Step 3e. Returns how many review questions lost their schedule (their text is kept in the checkpoint).</summary>
    private static async Task<int> MergeInsightsAsync(Run run, List<BookMatch> books)
    {
        if (books.Count == 0) return 0;
        var pairs = Pairs(books);
        var losers = await run.QueryAsync<InsightLoser>(SelectInsightLosers, pairs);
        var ids = new { ids = losers.Select(l => l.Id).ToArray() };
        var questions = losers.Count == 0 ? [] : await run.QueryAsync<(Guid InsightId, string Prompt, string Answer)>(SelectQuestionsOfLosers, ids);
        foreach (var loser in losers)
            await run.ExecuteAsync(InsertLoserCheckpoint, LoserCheckpoint(loser, questions.Where(q => q.InsightId == loser.Id)));
        await run.ExecuteAsync(DeleteLosers, ids);
        await run.ExecuteAsync(MoveInsightsToAccountBooks, pairs);
        return questions.Count;
    }

    /// <summary>
    /// The loser in full, as text (owner decisions 2026-11-02): its text the conclusion, its question a
    /// reader thought, its review questions (with answers) the open questions, its structured review
    /// an assistant suggestion. Only the questions' SRS schedule is not carried. An insight has no
    /// language, so the checkpoint's is unknown: <c>und</c>.
    /// </summary>
    private static DiscussionCheckpoint LoserCheckpoint(InsightLoser loser, IEnumerable<(Guid InsightId, string Prompt, string Answer)> questions)
    {
        var question = string.IsNullOrWhiteSpace(loser.Question) ? null : loser.Question;
        var request = new CheckpointRequest(
            loser.Id,
            question ?? "merged insight",
            question is null ? [] : [question],
            loser.ReviewJson is null ? [] : [CanonicalPayload.Canonicalize(JsonNode.Parse(loser.ReviewJson))],
            [loser.Text],
            questions.Select(q => string.IsNullOrWhiteSpace(q.Answer) ? q.Prompt : $"{q.Prompt} — {q.Answer}").ToArray(),
            "und",
            string.IsNullOrWhiteSpace(loser.ChapterSlug) ? null : loser.ChapterSlug,
            FileId: null,
            SharedChapterId: null);
        return new DiscussionCheckpoint
        {
            Id = loser.Id,
            BookId = loser.BookId,
            ChapterKey = request.ChapterKey,
            Topic = request.Topic!,
            ReaderThoughts = JsonSerializer.Serialize(request.ReaderThoughts),
            AssistantSuggestions = JsonSerializer.Serialize(request.AssistantSuggestions),
            Conclusions = JsonSerializer.Serialize(request.Conclusions),
            OpenQuestions = JsonSerializer.Serialize(request.OpenQuestions),
            Language = request.Language!,
            OperationId = loser.Id,
            PayloadSha256 = DiscussionPayloads.CheckpointSha256(loser.BookId, request),
            CreatedAt = loser.UpdatedAt,
        };
    }

    private const string SelectSharesToRehash = """
        SELECT id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language
        FROM shared_chapters WHERE user_id = @accountId AND id = ANY(@ids)
        """;
    private const string SetShareHashes = """
        UPDATE shared_chapters t SET payload_sha256 = m.hash
        FROM unnest(@ids, @hashes) AS m(id, hash)
        WHERE t.user_id = @accountId AND t.id = m.id
        """;

    private static async Task RehashSharesAsync(Run run, List<Guid> ids)
    {
        if (ids.Count == 0) return;
        var rows = await run.QueryAsync<SharedChapter>(SelectSharesToRehash, new { ids = ids.ToArray() });
        var hashes = rows.Select(s => DiscussionPayloads.ShareSha256(s.BookId, new ShareChapterRequest(
            s.OperationId, s.FileId, s.ChapterKey, s.ChapterTitle, s.ChapterText, JsonSerializer.Deserialize<JsonElement>(s.NotesSnapshot), s.Language)));
        await run.ExecuteAsync(SetShareHashes, new { ids = rows.Select(s => s.Id).ToArray(), hashes = hashes.ToArray() });
    }

    private const string SelectCheckpointsToRehash = """
        SELECT id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language
        FROM discussion_checkpoints WHERE user_id = @accountId AND id = ANY(@ids)
        """;
    private const string SetCheckpointHashes = """
        UPDATE discussion_checkpoints t SET payload_sha256 = m.hash
        FROM unnest(@ids, @hashes) AS m(id, hash)
        WHERE t.user_id = @accountId AND t.id = m.id
        """;

    private static async Task RehashCheckpointsAsync(Run run, List<Guid> ids)
    {
        if (ids.Count == 0) return;
        var rows = await run.QueryAsync<DiscussionCheckpoint>(SelectCheckpointsToRehash, new { ids = ids.Distinct().ToArray() });
        var hashes = rows.Select(c => DiscussionPayloads.CheckpointSha256(c.BookId, new CheckpointRequest(
            c.OperationId, c.Topic, Items(c.ReaderThoughts), Items(c.AssistantSuggestions), Items(c.Conclusions), Items(c.OpenQuestions),
            c.Language, c.ChapterKey, c.FileId, c.SharedChapterId)));
        await run.ExecuteAsync(SetCheckpointHashes, new { ids = rows.Select(c => c.Id).ToArray(), hashes = hashes.ToArray() });
    }

    private static string?[] Items(string json) => JsonSerializer.Deserialize<string?[]>(json)!;
}
