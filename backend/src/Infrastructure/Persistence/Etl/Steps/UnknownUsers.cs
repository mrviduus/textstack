using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// v2-plan §5.2 validation: 0 rows with an unknown <c>user_id</c> in the tables etl-v2 writes. Every owner is a
/// legacy user or admin (the only accounts the users step carries): the FKs prove the user exists in V2, this
/// proves it came from legacy. Read-only, on a dry and a real run; the failing ids are <c>table/user</c>.
/// </summary>
public static class EtlV2UnknownUsers
{
    private static readonly string[] Owned =
    [
        "books", "book_files", "reading_state", "annotations", "book_chapters", "ingestion_jobs",
        "vocabulary_words", "vocabulary_examples", "vocabulary_reviews", "book_insight", "review_question", "reading_sessions",
    ];

    public static readonly EtlV2Step Step = new("unknown-users", ["users", "admin_users"], Owned, RunAsync);

    private const string SelectLegacyOwners = "SELECT id FROM users UNION SELECT id FROM admin_users";

    // Owned's tables (code constants), one branch each.
    private static readonly string SelectV2Owners =
        string.Join(" UNION ", Owned.Select(t => $"SELECT DISTINCT '{t}' AS t, user_id FROM {t}"));

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var known = (await EtlV2Rows.SourceAsync<Guid>(context, SelectLegacyOwners, null, ct)).ToHashSet();
        var owners = await EtlV2Rows.TargetAsync<(string Table, Guid UserId)>(context, SelectV2Owners, null, ct);
        EtlV2Rows.Check(context, "unknown-user-ids: V2 rows whose owner is no legacy user or admin",
            owners.Where(o => !known.Contains(o.UserId)).Select(o => $"{o.Table}/{o.UserId}").Order(StringComparer.Ordinal));
    }
}
