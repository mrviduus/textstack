using System.Globalization;
using System.Security.Cryptography;
using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// Deterministic ids of the rows etl-v2 derives (v2-plan §5.2), so a re-run computes the same rows:
/// RFC 9562 UUIDv5 under <see cref="Namespace"/>. Names are the ids' big-endian (RFC) bytes.
/// </summary>
public static class EtlV2Ids
{
    /// <summary><c>uuid_v5(nil, "textstack-v2")</c>: the namespace of every id etl-v2 derives.</summary>
    public static readonly Guid Namespace = V5(Guid.Empty, "textstack-v2"u8.ToArray());

    /// <summary>A catalog pair's book: <c>uuid_v5('textstack-v2', user ‖ edition)</c>.</summary>
    public static Guid CatalogBook(Guid userId, Guid editionId) =>
        V5(Namespace, [.. userId.ToByteArray(bigEndian: true), .. editionId.ToByteArray(bigEndian: true)]);

    /// <summary>An example's or review's <c>operation_id</c>: <c>uuid_v5('textstack-v2', legacy row id)</c>.</summary>
    public static Guid Operation(Guid legacyId) => V5(Namespace, legacyId.ToByteArray(bigEndian: true));

    public static Guid V5(Guid ns, byte[] name)
    {
        var hash = SHA1.HashData([.. ns.ToByteArray(bigEndian: true), .. name]);
        hash[6] = (byte)((hash[6] & 0x0F) | 0x50);
        hash[8] = (byte)((hash[8] & 0x3F) | 0x80);
        return new Guid(hash.AsSpan(0, 16), bigEndian: true);
    }
}

/// <summary>
/// What every M3.3 mapper does with its planned rows (runbook docs/03-ops/v2-etl.md §4): compare each
/// with the target row under its id — absent: insert (a real run) or count (a dry run); equal:
/// nothing; different: a mismatch, reported and never overwritten. No ON CONFLICT: a unique key held
/// by another row fails the insert, and with it the run.
/// </summary>
internal static class EtlV2Rows
{
    /// <summary>
    /// Converges <paramref name="planned"/> on <paramref name="table"/>: registers the
    /// <c>{table}.target-matches-source</c> check (failures = mismatches, each listed by id in
    /// <see cref="EtlV2Context.CleanupActions"/>); a dry run also registers what it would insert.
    /// <paramref name="select"/> reads the rows <c>WHERE id = ANY(@ids)</c> as <typeparamref name="T"/>.
    /// </summary>
    public static async Task ConvergeAsync<T>(EtlV2Context context, NpgsqlTransaction tx, string table,
        IReadOnlyList<T> planned, Func<T, Guid> id, string select, string insert, CancellationToken ct)
    {
        var stored = await ReadAsync(tx, select, planned.Select(id).ToArray(), id, ct);
        List<T> missing = [];
        var mismatches = 0;
        foreach (var row in planned)
        {
            if (!stored.TryGetValue(id(row), out var current))
                missing.Add(row);
            else if (!EqualityComparer<T>.Default.Equals(row, current))
            {
                mismatches++;
                context.CleanupActions.Add($"{table} {id(row)}: the target row differs from what the source maps to; resolve by hand");
            }
        }
        if (!context.DryRun && missing.Count > 0)
            await tx.Connection!.ExecuteAsync(new CommandDefinition(insert, missing, tx, cancellationToken: ct));
        context.Checks.Add(new($"{table}.target-matches-source", mismatches));
        if (context.DryRun)
            context.Checks.Add(new($"{table}: would insert {missing.Count}, unchanged {planned.Count - missing.Count - mismatches}", 0));
    }

    /// <summary>The target rows under <paramref name="ids"/>, by id.</summary>
    public static async Task<Dictionary<Guid, T>> ReadAsync<T>(NpgsqlTransaction tx, string select, Guid[] ids, Func<T, Guid> id, CancellationToken ct) =>
        (await tx.Connection!.QueryAsync<T>(new CommandDefinition(select, new { ids }, tx, cancellationToken: ct))).ToDictionary(id);

    /// <summary>
    /// Rows a CHECK or FK of the target would refuse: listed by id with the reason, and counted as
    /// failures of <c>{table}.unmappable</c> — never carried half, never dropped silently.
    /// </summary>
    public static void Unmappable(EtlV2Context context, string table, IReadOnlyList<(Guid Id, string Reason)> rows)
    {
        foreach (var (rowId, reason) in rows)
            context.CleanupActions.Add($"{table} {rowId}: unmappable ({reason}); fix the source row or decide");
        context.Checks.Add(new($"{table}.unmappable", rows.Count));
    }

    /// <summary>Source rows not carried because what they hang on is not there: ids and the reason only.</summary>
    public static void Orphans(EtlV2Context context, string table, IEnumerable<(Guid Id, string Reason)> rows)
    {
        foreach (var (rowId, reason) in rows)
            context.OrphanCandidates.Add($"{table} {rowId}: {reason}");
    }

    private const string TargetUsers = "SELECT id FROM users";

    private const string SourceUsers = "SELECT id FROM users";

    /// <summary>
    /// The users a row may land on: the target's. A dry run adds the source's, since the users step
    /// (M3.2: every legacy user, same id) would have written them first.
    /// </summary>
    public static async Task<HashSet<Guid>> KnownUsersAsync(EtlV2Context context, NpgsqlTransaction target, CancellationToken ct)
    {
        var users = (await target.Connection!.QueryAsync<Guid>(new CommandDefinition(TargetUsers, transaction: target, cancellationToken: ct))).ToHashSet();
        if (context.DryRun)
            users.UnionWith(await context.Source.Connection!.QueryAsync<Guid>(new CommandDefinition(SourceUsers, transaction: context.Source, cancellationToken: ct)));
        return users;
    }

    /// <summary>
    /// A legacy <c>double precision</c> as the target's <c>numeric</c>: its shortest round-trip digits,
    /// so the stored value and the one a check compares are the same decimal.
    /// </summary>
    public static decimal Numeric(double value) =>
        decimal.Parse(value.ToString("R", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary>A step's body with the target transaction it writes in: committed on success (a dry run never writes, so it has nothing to commit).</summary>
    public static async Task InTargetAsync(EtlV2Context context, Func<NpgsqlTransaction, Task> body, CancellationToken ct)
    {
        await using var conn = await context.Target.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await body(tx);
        await tx.CommitAsync(ct);
    }
}
