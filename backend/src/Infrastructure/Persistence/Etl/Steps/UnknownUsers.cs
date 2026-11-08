namespace Infrastructure.Persistence.Etl;

/// <summary>
/// v2-plan §5.2 validation: 0 rows with an unknown <c>user_id</c> in the tables etl-v2 writes: an owner that is
/// neither a legacy user or admin nor a V2 user (the FKs say it cannot be; this proves it). A V2-only user's rows
/// are not unknown: report-only, like the user (owner 2026-11-08), each a "V2 row with no legacy row" cleanup line of
/// its step. Read-only, on a dry and a real run; the failing ids are <c>table/user</c>.
/// </summary>
public static class EtlV2UnknownUsers
{
    // Its tables are every other step's targets (Owned), so it declares none of its own: they are counted there.
    public static readonly EtlV2Step Step = new("unknown-users", ["users", "admin_users"], [], RunAsync);

    /// <summary>
    /// The tables checked: every target of <see cref="EtlV2.Steps"/> but <c>users</c>, each with a <c>user_id</c>, so a
    /// later step's table cannot skip the check. Computed at run time: <see cref="EtlV2.Steps"/> holds this step.
    /// </summary>
    internal static IReadOnlyList<string> Owned() =>
        [.. EtlV2.Steps.SelectMany(s => s.Targets).Where(t => t != "users").Distinct().Order(StringComparer.Ordinal)];

    // The owners V2's users table does not hold, per table (code constants); legacy's are then checked client-side.
    private static string SelectV2Owners(IEnumerable<string> tables) =>
        "SELECT DISTINCT t, user_id FROM (" + string.Join(" UNION ALL ", tables.Select(t => $"SELECT '{t}' AS t, user_id FROM {t}"))
        + ") owners WHERE user_id NOT IN (SELECT id FROM users)";

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var carried = await EtlV2Rows.CarriedUserIdsAsync(context, ct);
        var owners = await EtlV2Rows.TargetAsync<(string Table, Guid UserId)>(context, SelectV2Owners(Owned()), null, ct);
        EtlV2Rows.Check(context, "unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users",
            owners.Where(o => !carried.Contains(o.UserId)).Select(o => $"{o.Table}/{o.UserId}").Order(StringComparer.Ordinal));
    }
}
