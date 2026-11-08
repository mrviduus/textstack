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
            new() { FileId = book.CurrentFile!.Id, CurrentLocator = TestJson.Cfi(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, default, Ct);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() =>
            conn.ExecuteAsync(new CommandDefinition(sql, new { userId = book.UserId, bookId = book.Id }, cancellationToken: Ct)));

        Assert.Equal(("23514", constraint), (error.SqlState, error.ConstraintName));
    }

    [Theory]
    [InlineData("fb2")]
    [InlineData("mobi")]
    [InlineData("azw3")]
    [InlineData("cbz")]
    public async Task BookFileFormat_Added0005_IsAccepted(string format)
    {
        var book = await db.NewReaderWithBookAsync();

        await db.ExecAsync("UPDATE book_files SET format = @format WHERE user_id = @userId AND book_id = @bookId",
            new { format, userId = book.UserId, bookId = book.Id });

        Assert.Equal(format, await db.ScalarAsync<string>("SELECT format FROM book_files WHERE book_id = @bookId", new { bookId = book.Id }));
    }

    [Fact]
    public async Task BookFileFormat_Unknown_IsRefusedByName()
    {
        var book = await db.NewReaderWithBookAsync();
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync(new CommandDefinition(
            "UPDATE book_files SET format = 'docx' WHERE book_id = @bookId", new { bookId = book.Id }, cancellationToken: Ct)));

        Assert.Equal(("23514", "ck_book_files_format"), (error.SqlState, error.ConstraintName));
    }

    [Fact]
    public async Task Down0005_RowInNewFormat_RefusesAndChangesNothing()
    {
        // Fail closed: the down never rewrites or deletes a real book to fit the old list.
        var book = await db.NewReaderWithBookAsync();
        var down = await File.ReadAllTextAsync(Path.Combine(PostgresFixture.RepoRoot(), "database/v2/migrations/0005_book_formats.down.sql"), Ct);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("UPDATE book_files SET format = 'fb2' WHERE book_id = @bookId", new { bookId = book.Id }, tx, cancellationToken: Ct));

        var error = await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync(new CommandDefinition(down, transaction: tx, cancellationToken: Ct)));

        Assert.StartsWith("0005 down refused: ", error.MessageText);
        await tx.RollbackAsync(Ct);
        Assert.Contains("'cbz'", await db.ScalarAsync<string>(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_book_files_format'", new { }));
    }
}
