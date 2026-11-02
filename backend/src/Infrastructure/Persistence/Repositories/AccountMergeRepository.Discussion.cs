using System.Text.Json.Nodes;
using Application.Common;
using Application.Discussion;
using Contracts.V2;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>The merge's discussion: step 3e (insights of matched books), share links, and the share and checkpoint hashes of step 7.</summary>
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

    // One per (book, chapter) both hold (NULLS NOT DISTINCT, as the unique index). Owner decision 7: the
    // newer stays current, the other (a tie: the guest's) is kept as a checkpoint.
    private const string InsightClashes = """
        FROM book_insight g
        JOIN unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book) ON g.book_id = m.guest_book
        JOIN book_insight a ON a.user_id = @accountId AND a.book_id = m.account_book AND a.chapter_slug IS NOT DISTINCT FROM g.chapter_slug
        WHERE g.user_id = @guestId
        """;
    private const string GuestNewer = "g.updated_at > a.updated_at";
    private const string LoserId = $"CASE WHEN {GuestNewer} THEN a.id ELSE g.id END";

    private const string SelectInsightLosers = $"""
        SELECT {LoserId} AS id, m.account_book AS book_id, g.chapter_slug,
               CASE WHEN {GuestNewer} THEN a.text ELSE g.text END AS text,
               CASE WHEN {GuestNewer} THEN a.question ELSE g.question END AS question,
               CASE WHEN {GuestNewer} THEN a.review_json ELSE g.review_json END AS review_json,
               CASE WHEN {GuestNewer} THEN a.updated_at ELSE g.updated_at END AS updated_at
        {InsightClashes}
        """;

    private const string SelectQuestionsOfLosers = $"""
        SELECT q.book_insight_id, q.prompt, q.answer FROM review_question q
        JOIN (SELECT {LoserId} AS id {InsightClashes}) l ON l.id = q.book_insight_id
        WHERE q.user_id IN (@guestId, @accountId)
        ORDER BY q.block_index, q.created_at, q.id
        """;

    /// <summary>
    /// The loser in full, as text (owner decisions 2026-11-02): its text the conclusion, its question a
    /// reader thought, its review questions (with answers) the open questions, its structured review
    /// an assistant suggestion. Only the questions' SRS schedule is not carried. An insight has no
    /// language, so the checkpoint's is unknown: <c>und</c>. Its id is the checkpoint's id and operation
    /// id: deterministic, so nothing can add it twice.
    /// </summary>
    private static DiscussionCheckpoint LoserCheckpoint(InsightLoser loser, IEnumerable<(Guid InsightId, string Prompt, string Answer)> questions)
    {
        var question = string.IsNullOrWhiteSpace(loser.Question) ? null : loser.Question;
        var checkpoint = DiscussionPayloads.Checkpoint(loser.Id, Guid.Empty, loser.BookId, new CheckpointRequest(
            loser.Id,
            question ?? "merged insight",
            question is null ? [] : [question],
            loser.ReviewJson is null ? [] : [CanonicalPayload.Canonicalize(JsonNode.Parse(loser.ReviewJson))],
            [loser.Text],
            questions.Select(q => string.IsNullOrWhiteSpace(q.Answer) ? q.Prompt : $"{q.Prompt} — {q.Answer}").ToArray(),
            "und",
            string.IsNullOrWhiteSpace(loser.ChapterSlug) ? null : loser.ChapterSlug,
            FileId: null,
            SharedChapterId: null));
        checkpoint.CreatedAt = loser.UpdatedAt;
        return checkpoint;
    }

    private static object LoserArgs(List<InsightLoser> losers, List<(Guid InsightId, string Prompt, string Answer)> questions)
    {
        var byInsight = questions.ToLookup(q => q.InsightId);
        var kept = losers.Select(l => LoserCheckpoint(l, byInsight[l.Id])).ToList();
        return new
        {
            loserIds = kept.Select(c => c.Id).ToArray(),
            loserBooks = kept.Select(c => c.BookId).ToArray(),
            chapterKeys = kept.Select(c => c.ChapterKey).ToArray(),
            topics = kept.Select(c => c.Topic).ToArray(),
            readerThoughts = kept.Select(c => c.ReaderThoughts).ToArray(),
            assistantSuggestions = kept.Select(c => c.AssistantSuggestions).ToArray(),
            conclusions = kept.Select(c => c.Conclusions).ToArray(),
            openQuestions = kept.Select(c => c.OpenQuestions).ToArray(),
            hashes = kept.Select(c => c.PayloadSha256).ToArray(),
            // Arrays skip Dapper's UTC handler, and Npgsql writes timestamptz only from offset 0.
            createdAts = kept.Select(c => c.CreatedAt.ToUniversalTime()).ToArray(),
        };
    }

    private const string InsertLoserCheckpoints = """
        INSERT INTO discussion_checkpoints (id, user_id, book_id, chapter_key, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256, created_at)
        SELECT m.id, @accountId, m.book_id, m.chapter_key, m.topic, CAST(m.reader_thoughts AS jsonb), CAST(m.assistant_suggestions AS jsonb),
               CAST(m.conclusions AS jsonb), CAST(m.open_questions AS jsonb), 'und', m.id, m.payload_sha256, m.created_at
        FROM unnest(@loserIds, @loserBooks, @chapterKeys, @topics, @readerThoughts, @assistantSuggestions, @conclusions, @openQuestions, @hashes, @createdAts)
            AS m(id, book_id, chapter_key, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, payload_sha256, created_at)
        """;

    // After its checkpoint holds its text: its review questions go with it (cascade).
    private const string DeleteLosers = "DELETE FROM book_insight WHERE user_id IN (@guestId, @accountId) AND id = ANY(@loserIds)";

    // Winners and insights with no clash; their review questions follow by (user_id, book_insight_id).
    private const string MoveInsightsToAccountBooks = $"UPDATE book_insight t {LeftoverTail}";

    // The same share under both identities: the checkpoint now names the account's, when that share is
    // on the checkpoint's (merged) book, chapter and file version, as the share FK and the same-chapter
    // rule require. Otherwise it stays unlinked, its text intact.
    private const string RelinkToAccountShares = """
        UPDATE discussion_checkpoints c SET shared_chapter_id = s.id
        FROM unnest(@checkpoints, @shares) AS m(checkpoint, share)
        JOIN shared_chapters s ON s.user_id = @accountId AND s.id = m.share
        WHERE c.user_id = @accountId AND c.id = m.checkpoint
          AND s.book_id = c.book_id AND s.chapter_key = c.chapter_key AND s.file_id IS NOT DISTINCT FROM c.file_id
        """;

    private const string SelectSharesToRehash = """
        SELECT id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language
        FROM shared_chapters WHERE user_id = @accountId AND id = ANY(@shareIds)
        """;
    private const string SelectCheckpointsToRehash = """
        SELECT id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language
        FROM discussion_checkpoints WHERE user_id = @accountId AND id = ANY(@checkpointIds)
        """;

    private const string SetShareHashes = $"UPDATE shared_chapters t SET payload_sha256 = m.hash FROM unnest(@shareIds, @shareHashes) {SetHashesTail}";
    private const string SetCheckpointHashes = $"UPDATE discussion_checkpoints t SET payload_sha256 = m.hash FROM unnest(@checkpointIds, @checkpointHashes) {SetHashesTail}";
}
