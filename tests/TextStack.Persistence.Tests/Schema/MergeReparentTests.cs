using Dapper;
using Domain.Library;
using Application.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Schema;

/// <summary>
/// The mechanism the guest→account merge rests on (migration 0001, sync PDD owner decision 12): an
/// <c>UPDATE … SET user_id</c> on the aggregate roots is followed by every composite
/// <c>(user_id, …)</c> FK. Three edges are the merge's own, each pinned here: the order, a row the
/// key does not reach, and a unique key the target already holds.
/// </summary>
public class MergeReparentTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] UserOwnedTables =
    [
        "books", "book_files", "reading_state", "reading_sessions", "annotations",
        "vocabulary_words", "vocabulary_examples", "vocabulary_reviews",
        "shared_chapters", "discussion_checkpoints", "book_insight", "review_question",
        "book_chapters", "ingestion_jobs",
    ];

    private const string MoveWords = "UPDATE vocabulary_words SET user_id = @to WHERE user_id = @from";
    private const string MoveBooks = "UPDATE books SET user_id = @to WHERE user_id = @from";
    private const string MoveBooklessSessions = "UPDATE reading_sessions SET user_id = @to WHERE user_id = @from AND book_id IS NULL";

    [Fact]
    public async Task ReparentingWordsThenBooks_MovesEveryRowTheKeyReaches_AndNoBooklessSession()
    {
        var (alice, bob, book, share) = await AliceWithEverythingAndBobAsync();
        foreach (var table in UserOwnedTables) Assert.Equal((table, Seeded(table)), (table, await db.CountAsync(table, alice)));

        await RunAsync(MoveWords + ";" + MoveBooks, alice, bob);

        foreach (var table in UserOwnedTables.Where(t => t != "reading_sessions"))
            Assert.Equal((table, 0L, 1L), (table, await db.CountAsync(table, alice), await db.CountAsync(table, bob)));
        // A session of a deleted book has no (user_id, book_id) to follow: the merge moves it itself.
        Assert.Equal((1L, 1L), (await db.CountAsync("reading_sessions", alice), await db.CountAsync("reading_sessions", bob)));
        await RunAsync(MoveBooklessSessions, alice, bob);
        Assert.Equal((0L, 2L), (await db.CountAsync("reading_sessions", alice), await db.CountAsync("reading_sessions", bob)));
        // The share link followed too, so the checkpoint still names its share.
        var kept = Assert.Single((await new CheckpointRepository(db.DataSource).ListAsync(bob, book.Id, null, 10, null, Ct)).Items);
        Assert.Equal(share.Id, kept.SharedChapterId);
    }

    [Fact]
    public async Task ReparentingBooksBeforeWords_IsRefusedByTheExamplesWordFk()
    {
        var (alice, bob, _, _) = await AliceWithEverythingAndBobAsync();

        // The cascade from the book moves the example first; its word FK is immediate and the word
        // is still alice's.
        var error = await Assert.ThrowsAsync<PostgresException>(() => RunAsync(MoveBooks + ";" + MoveWords, alice, bob));

        Assert.Equal(("23503", "fk_vocabulary_examples_vocabulary_words_user_id_word_id"), (error.SqlState, error.ConstraintName));
        Assert.Equal(1L, await db.CountAsync("books", alice));
    }

    [Fact]
    public async Task ReparentingOntoAnOperationIdTheTargetHolds_IsRefusedAndMovesNothing()
    {
        var (alice, bob, book, _) = await AliceWithEverythingAndBobAsync();
        var checkpoints = new CheckpointRepository(db.DataSource);
        // Bob already holds a checkpoint under the operation id alice's checkpoint carries.
        var bobs = NewCheckpoint(await db.NewBookAsync(bob));
        bobs.OperationId = (await checkpoints.ListAsync(alice, book.Id, null, 1, null, Ct)).Items[0].OperationId;
        await checkpoints.AppendAsync(bobs, Ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() => RunAsync(MoveWords + ";" + MoveBooks, alice, bob));

        Assert.Equal(("23505", "ak_discussion_checkpoints_user_id_operation_id"), (error.SqlState, error.ConstraintName));
        foreach (var table in UserOwnedTables) Assert.Equal((table, Seeded(table)), (table, await db.CountAsync(table, alice)));
    }

    /// <summary>How many rows the seed gives alice in <paramref name="table"/>: two sessions (one of a deleted book), one of everything else.</summary>
    private static long Seeded(string table) => table == "reading_sessions" ? 2 : 1;

    /// <summary>Runs <paramref name="sql"/> as one transaction, with the deferred FKs checked at its end.</summary>
    private async Task RunAsync(string sql, Guid from, Guid to)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(sql + "; SET CONSTRAINTS ALL IMMEDIATE", new { from, to }, tx, cancellationToken: Ct));
        await tx.CommitAsync(Ct);
    }

    /// <summary>Alice with one row in every user-owned table (two sessions: one of the book, one of a deleted book), and an empty Bob.</summary>
    private async Task<(Guid Alice, Guid Bob, Book Book, Domain.Discussion.SharedChapter Share)> AliceWithEverythingAndBobAsync()
    {
        var alice = await db.NewReaderAsync();
        var bob = await db.NewReaderAsync();
        var book = await db.NewBookAsync(alice);
        var file = book.CurrentFile!;
        await new ReadingStateRepository(db.DataSource).AdvanceAsync(alice, book.Id,
            new() { FileId = file.Id, CurrentLocator = TestJson.Page(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, Ct);
        await new AnnotationRepository(db.DataSource).SaveAsync(alice,
            new() { Id = Guid.NewGuid(), UserId = alice, BookId = book.Id, FileId = file.Id, SelectedText = "quoted", Locator = TestJson.Page(1) }, null, Ct);
        var vocabulary = new VocabularyRepository(db.DataSource);
        var card = (await vocabulary.SaveWordAsync(alice, new() { Id = Guid.NewGuid(), UserId = alice, Language = "en", Word = "quiver", WordKey = "quiver" }, Ct)).Word!;
        await vocabulary.AddExampleAsync(alice, new()
        {
            Id = Guid.NewGuid(),
            UserId = alice,
            WordId = card.Id,
            BookId = book.Id,
            FileId = file.Id,
            Sentence = "A quiver of arrows.",
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256("A quiver of arrows."),
        }, Ct);
        await vocabulary.RecordReviewAsync(alice, new()
        {
            Id = Guid.NewGuid(),
            UserId = alice,
            WordId = card.Id,
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256("correct"),
            ReviewMode = "flashcard",
            IsCorrect = true,
            ClientRecordedAt = DateTimeOffset.UtcNow,
        }, c => new ReviewSchedule(c.Stage + 1, 1m, 0), Ct);
        var share = NewShare(book);
        await new SharedChapterRepository(db.DataSource).ShareAsync(share, Ct);
        await new CheckpointRepository(db.DataSource).AppendAsync(NewCheckpoint(book, share), Ct);
        var insight = await new BookInsightRepository(db.DataSource).SaveReviewAsync(NewInsight(book, "ch-1", reviewJson: "{}"), Ct);
        await new ReviewQuestionRepository(db.DataSource).ReplaceForInsightAsync(alice, insight.Id,
            [new() { Id = Guid.NewGuid(), UserId = alice, BookInsightId = insight.Id, Prompt = "Why?", Answer = "Because.", PromptHash = "h1", NextReviewAt = DateTimeOffset.UtcNow }], Ct);
        // No repository writes these yet (sessions: M2.2; the transitional tables: M1.5).
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            INSERT INTO reading_sessions (id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES (gen_random_uuid(), @alice, @bookId, gen_random_uuid(), now(), now(), 60, 100, 0, 0.1, now()),
                   (gen_random_uuid(), @alice, NULL, gen_random_uuid(), now(), now(), 60, 100, 0, 0.1, now());
            INSERT INTO book_chapters (id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, created_at)
            VALUES (gen_random_uuid(), @alice, @bookId, @fileId, 'ch-1', 1, 'One', '<p>x</p>', 'x', now());
            INSERT INTO ingestion_jobs (id, user_id, book_id, file_id, status, attempt_count, created_at)
            VALUES (gen_random_uuid(), @alice, @bookId, @fileId, 'succeeded', 1, now());
            """, new { alice, bookId = book.Id, fileId = file.Id }, cancellationToken: Ct));
        return (alice, bob, book, share);
    }
}
