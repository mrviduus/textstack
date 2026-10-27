using Domain;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Npgsql;

namespace TextStack.IntegrationTests;

/// <summary>
/// The schema comes from <c>database/migrations/</c> (#931); the code still reads it through the
/// EF Core model. Nothing ties the two together, so this does, on a database built by
/// <c>database/migrate.sh</c>: every column the model maps exists with the model's type and
/// nullability, and every NOT NULL column without a default on a mapped table is in the model
/// (EF would insert without it and fail). A migration that drops or retypes a column the code still
/// uses, or adds one the code cannot write, fails here, not in production.
///
/// Runs on <c>TEST_DB_CONNECTION</c> (CI's backend job points it at the database the runner just
/// built) and SKIPS when it's unset.
/// </summary>
public class SchemaDriftTests
{
    private static string? DbConn => Environment.GetEnvironmentVariable("TEST_DB_CONNECTION");

    // Known differences, each with its reason, as the exact line the test prints: any other change
    // to the same column still fails. Keep this list short: a new entry is a decision.
    private static readonly HashSet<string> Accepted =
    [
        // Nullable column, non-null property: the chapters trigger fills it on every insert/update.
        "chapters.search_vector: model tsvector not null, database tsvector null",
    ];

    [Fact]
    public async Task EfModel_EveryMappedColumn_ExistsWithSameTypeAndNullability()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        var ct = TestContext.Current.CancellationToken;

        // The model the Api runs with; building it opens no connection.
        await using var ctx = new AppDbContext(AppDbContextOptions.For(DbConn), new CurrentSite(SiteConstants.DefaultSiteId));

        var expected = new List<Column>();
        foreach (var entity in ctx.Model.GetEntityTypes())
        {
            if (entity.GetTableName() is not { } table)
                continue;
            var store = StoreObjectIdentifier.Table(table, entity.GetSchema());
            foreach (var p in entity.GetProperties())
                if (p.GetColumnName(store) is { } column)
                    expected.Add(new Column(table, column, p.GetColumnType().ToLowerInvariant(), p.IsColumnNullable(store)));
        }
        Assert.NotEmpty(expected);

        // format_type gives the full type ("character varying(255)", "vector(1536)"), which
        // information_schema.data_type cuts short. "Required": NOT NULL with no default, not generated.
        var actual = new Dictionary<(string, string), Column>();
        var required = new List<(string Table, string Name)>();
        await using (var conn = new NpgsqlConnection(DbConn))
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT c.table_name, c.column_name, format_type(a.atttypid, a.atttypmod), c.is_nullable = 'YES',
                       c.is_nullable = 'NO' AND c.column_default IS NULL AND c.is_generated = 'NEVER' AND c.is_identity = 'NO'
                FROM information_schema.columns c
                JOIN pg_attribute a ON a.attrelid = format('public.%I', c.table_name)::regclass AND a.attname = c.column_name
                WHERE c.table_schema = 'public'
                """, conn);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                actual[(r.GetString(0), r.GetString(1))] = new Column(r.GetString(0), r.GetString(1), r.GetString(2), r.GetBoolean(3));
                if (r.GetBoolean(4))
                    required.Add((r.GetString(0), r.GetString(1)));
            }
        }

        var mappedTables = expected.Select(e => e.Table).ToHashSet();
        var mapped = expected.Select(e => (e.Table, e.Name)).ToHashSet();
        var drift = expected
            .Select(e => actual.TryGetValue((e.Table, e.Name), out var a)
                ? a == e ? null : $"{e.Table}.{e.Name}: model {e.Type}{(e.Nullable ? " null" : " not null")}, database {a.Type}{(a.Nullable ? " null" : " not null")}"
                : $"{e.Table}.{e.Name}: in the model, missing in the database")
            .OfType<string>()
            .Concat(required
                .Where(c => mappedTables.Contains(c.Table) && !mapped.Contains(c))
                .Select(c => $"{c.Table}.{c.Name}: NOT NULL without a default in the database, not in the model"))
            .Where(d => !Accepted.Contains(d))
            .ToList();
        Assert.True(drift.Count == 0, "EF model and database/migrations disagree:\n" + string.Join("\n", drift));
    }

    private sealed record Column(string Table, string Name, string Type, bool Nullable);
}
