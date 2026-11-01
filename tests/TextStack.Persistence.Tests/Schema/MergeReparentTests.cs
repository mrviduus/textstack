using Dapper;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Schema;

/// <summary>
/// The mechanism the guest→account merge rests on (migration 0001, sync PDD owner decision 12): an
/// <c>UPDATE … SET user_id</c> on the aggregate roots is followed by every composite
/// <c>(user_id, …)</c> FK. Whether a row may move at all (collisions, ownership) is the merge's own
/// check and not tested here.
/// </summary>
public class MergeReparentTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] UserOwnedTables =
    [
        "books", "book_files", "reading_state", "annotations", "vocabulary_words", "vocabulary_examples",
        "shared_chapters", "discussion_checkpoints", "book_insight", "review_question",
    ];

    [Fact]
    public async Task UpdatingUserIdOfBooksAndWords_MovesEveryDependentRowWithThem()
    {
        var alice = await db.NewReaderAsync();
        var bob = await db.NewReaderAsync();
        var book = await db.NewBookAsync(alice);
        var reading = new ReadingStateRepository(db.DataSource);
        await reading.AdvanceAsync(alice, book.Id, new() { FileId = book.CurrentFile!.Id, CurrentLocator = TestJson.Page(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, Ct);
        await new AnnotationRepository(db.DataSource).SaveAsync(alice, new()
        {
            Id = Guid.NewGuid(),
            UserId = alice,
            BookId = book.Id,
            FileId = book.CurrentFile.Id,
            SelectedText = "quoted",
            Locator = TestJson.Page(1),
        }, null, Ct);
        var vocabulary = new VocabularyRepository(db.DataSource);
        var card = (await vocabulary.SaveWordAsync(alice, new() { Id = Guid.NewGuid(), UserId = alice, Language = "en", Word = "quiver", WordKey = "quiver" }, Ct)).Word!;
        await vocabulary.AddExampleAsync(alice, new()
        {
            Id = Guid.NewGuid(),
            UserId = alice,
            WordId = card.Id,
            BookId = book.Id,
            FileId = book.CurrentFile.Id,
            Sentence = "A quiver of arrows.",
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256("A quiver of arrows."),
        }, Ct);
        var share = NewShare(book);
        await new SharedChapterRepository(db.DataSource).ShareAsync(share, Ct);
        await new CheckpointRepository(db.DataSource).AppendAsync(NewCheckpoint(book, share), Ct);
        var insight = await new BookInsightRepository(db.DataSource).SaveReviewAsync(NewInsight(book, "ch-1", reviewJson: "{}"), Ct);
        await new ReviewQuestionRepository(db.DataSource).ReplaceForInsightAsync(alice, insight.Id, [new()
        {
            Id = Guid.NewGuid(), UserId = alice, BookInsightId = insight.Id, Prompt = "Why?", Answer = "Because.", PromptHash = "h1", NextReviewAt = DateTimeOffset.UtcNow,
        }], Ct);
        foreach (var table in UserOwnedTables) Assert.Equal(1, await db.CountAsync(table, alice));

        // Words before books: an example's word FK is immediate, its book FKs are deferred, so the
        // cascade from the word must have moved the example before the one from the book checks it.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
        await using (var tx = await conn.BeginTransactionAsync(Ct))
        {
            await conn.ExecuteAsync(new CommandDefinition("""
                UPDATE vocabulary_words SET user_id = @bob WHERE user_id = @alice;
                UPDATE books SET user_id = @bob WHERE user_id = @alice;
                SET CONSTRAINTS ALL IMMEDIATE;
                """, new { alice, bob }, tx, cancellationToken: Ct));
            await tx.CommitAsync(Ct);
        }

        foreach (var table in UserOwnedTables)
            Assert.Equal((table, 0L, 1L), (table, await db.CountAsync(table, alice), await db.CountAsync(table, bob)));
        // The share link followed too, so the checkpoint still names its share.
        var kept = Assert.Single((await new CheckpointRepository(db.DataSource).ListAsync(bob, book.Id, null, 10, null, Ct)).Items);
        Assert.Equal(share.Id, kept.SharedChapterId);
    }
}
