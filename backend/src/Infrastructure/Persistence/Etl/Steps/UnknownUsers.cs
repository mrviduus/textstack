using Dapper;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// v2-plan §5.2 validation: 0 rows with an unknown <c>user_id</c> in the tables M3.3 writes — every
/// owner is a legacy user or admin (the only accounts M3.2 carries). The FKs prove the user exists in
/// the target; this proves it came from the source. Read-only; a real run only.
/// </summary>
public static class EtlV2UnknownUsers
{
    public static readonly string[] SourceTables = ["users", "admin_users"];

    public static readonly string[] TargetTables =
        [.. EtlV2Catalog.TargetTables, .. EtlV2Vocabulary.TargetTables, .. EtlV2Insights.TargetTables, .. EtlV2Sessions.TargetTables];

    public static readonly EtlV2Step Step = new("unknown-users", RunAsync);

    private const string SourceOwners = "SELECT id FROM users UNION SELECT id FROM admin_users";

    // TargetTables, one branch each.
    private const string TargetOwners = """
        SELECT t, user_id, count(*) AS rows FROM (
            SELECT 'books' AS t, user_id FROM books
            UNION ALL SELECT 'annotations', user_id FROM annotations
            UNION ALL SELECT 'vocabulary_words', user_id FROM vocabulary_words
            UNION ALL SELECT 'vocabulary_examples', user_id FROM vocabulary_examples
            UNION ALL SELECT 'vocabulary_reviews', user_id FROM vocabulary_reviews
            UNION ALL SELECT 'book_insight', user_id FROM book_insight
            UNION ALL SELECT 'review_question', user_id FROM review_question
            UNION ALL SELECT 'reading_sessions', user_id FROM reading_sessions) owners
        GROUP BY t, user_id
        """;

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        if (context.DryRun)
            return;
        var source = context.Source;
        var known = (await source.Connection!.QueryAsync<Guid>(new CommandDefinition(SourceOwners, transaction: source, cancellationToken: ct))).ToHashSet();
        await using var conn = await context.Target.OpenConnectionAsync(ct);
        var owners = await conn.QueryAsync<(string Table, Guid UserId, long Rows)>(new CommandDefinition(TargetOwners, cancellationToken: ct));
        var unknown = owners.Where(o => !known.Contains(o.UserId)).ToList();
        foreach (var (table, userId, rows) in unknown)
            context.CleanupActions.Add($"{table}: {rows} row(s) of user {userId}, who is no source user");
        context.Checks.Add(new("unknown-user-ids", (int)unknown.Sum(o => o.Rows)));
    }
}
