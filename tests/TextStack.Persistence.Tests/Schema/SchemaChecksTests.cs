using Dapper;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Schema;

/// <summary>The CHECKs migration 0001 added, each refusing the row it exists for, by name.</summary>
public class SchemaChecksTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("UPDATE reading_state SET reset_revision = 0 WHERE user_id = @userId AND book_id = @bookId", "ck_reading_state_reset_revision")]
    [InlineData("UPDATE reading_state SET reset_revision = revision + 1 WHERE user_id = @userId AND book_id = @bookId", "ck_reading_state_reset_revision")]
    [InlineData("UPDATE books SET revision = 0 WHERE user_id = @userId AND id = @bookId", "ck_books_revision")]
    [InlineData("""
        INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, review_json, created_at, updated_at)
        VALUES (gen_random_uuid(), @userId, @bookId, NULL, 'a review of no chapter', '{}', now(), now())
        """, "ck_book_insight_review_chapter")]
    public async Task Check_RowItExistsFor_IsRefusedByName(string sql, string constraint)
    {
        var book = await db.NewReaderWithBookAsync();
        await new ReadingStateRepository(db.DataSource).AdvanceAsync(book.UserId, book.Id,
            new() { FileId = book.CurrentFile!.Id, CurrentLocator = TestJson.Page(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, Ct);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() =>
            conn.ExecuteAsync(new CommandDefinition(sql, new { userId = book.UserId, bookId = book.Id }, cancellationToken: Ct)));

        Assert.Equal(("23514", constraint), (error.SqlState, error.ConstraintName));
    }
}
