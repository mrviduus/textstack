using Dapper;
using Domain.Library;
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

    private const string MoveWords = "UPDATE vocabulary_words SET user_id = @to WHERE user_id = @from";
    private const string MoveBooks = "UPDATE books SET user_id = @to WHERE user_id = @from";
    private const string MoveBooklessSessions = "UPDATE reading_sessions SET user_id = @to WHERE user_id = @from AND book_id IS NULL";

    [Fact]
    public async Task ReparentingWordsThenBooks_MovesEveryRowTheKeyReaches_AndNoBooklessSession()
    {
        var (alice, bob, book, share) = await AliceWithEverythingAndBobAsync();

        await RunAsync(MoveWords + ";" + MoveBooks, alice, bob);

        // The session of a deleted book has no (user_id, book_id) to follow: the merge moves it itself.
        foreach (var (table, hers, his) in await RowsAsync(alice, bob))
            Assert.Equal((table, table == "reading_sessions" ? 1L : 0L, 1L), (table, hers, his));
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
        foreach (var (table, hers, _) in await RowsAsync(alice, bob)) Assert.Equal((table, Seeded(table)), (table, hers));
    }

    /// <summary>
    /// Alice's and bob's row counts in the two roots and every table whose ownership is in a composite
    /// key (ADR-031 rule 2), from the catalog, so a table added later is asserted on without anyone
    /// listing it. Tables that point only at <c>users</c> (tokens, grants, keys, agent runs) are reached
    /// by no cascade and are the merge's own decision.
    /// </summary>
    private async Task<IReadOnlyList<(string Table, long Hers, long His)>> RowsAsync(Guid alice, Guid bob)
    {
        const string tables = """
            SELECT conrelid::regclass::text FROM pg_constraint
            WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confrelid <> 'public.users'::regclass
            UNION SELECT 'books' UNION SELECT 'vocabulary_words'
            ORDER BY 1
            """;
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var names = (await conn.QueryAsync<string>(new CommandDefinition(tables, cancellationToken: Ct))).AsList();
        var counts = string.Join(" UNION ALL ", names.Select(t =>
            $"SELECT '{t}' AS tbl, count(*) FILTER (WHERE user_id = @alice) AS hers, count(*) FILTER (WHERE user_id = @bob) AS his FROM {t}"));
        return (await conn.QueryAsync<(string, long, long)>(new CommandDefinition(counts, new { alice, bob }, cancellationToken: Ct))).AsList();
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
        var (book, share) = await db.SeedEverythingAsync(alice);
        return (alice, bob, book, share);
    }
}
