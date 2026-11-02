using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Api.Extensions;

/// <summary>
/// The `migrator` compose service owns the schema (ADR-021, ADR-026); the Api never migrates, it
/// only checks. A schema behind this build — after <c>migrate.sh down</c>, or a migrator that did
/// not run — is reported (Critical log at start, <c>/health/ready</c> 503), never fatal.
/// <c>textstack_v2</c> has a ledger of its own (<see cref="V2Known"/>), read only by
/// <see cref="V2.V2Readiness"/>: a V2 schema that is behind gates <c>/me/v2/*</c>, never the site (#1053).
/// </summary>
internal static class SchemaVersion
{
    private const string Suffix = ".up.sql";

    /// <summary>The migrations this build was written against, oldest first: "0000_baseline", …
    /// Embedded from <c>database/migrations/</c> at build time (Api.csproj).</summary>
    public static readonly IReadOnlyList<string> Known = Embedded("migrations/");

    /// <summary>The same for <c>textstack_v2</c>, embedded from <c>database/v2/migrations/</c>.</summary>
    public static readonly IReadOnlyList<string> V2Known = Embedded("v2migrations/");

    private static List<string> Embedded(string prefix) => typeof(SchemaVersion).Assembly.GetManifestResourceNames()
        .Where(n => n.StartsWith(prefix, StringComparison.Ordinal) && n.EndsWith(Suffix, StringComparison.Ordinal))
        .Select(n => n[prefix.Length..^Suffix.Length])
        .Order(StringComparer.Ordinal)
        .ToList();

    /// <summary>Known migrations the ledger does not list. No ledger yet = all of them.</summary>
    public static async Task<List<string>> PendingAsync(DbContext db, CancellationToken ct = default)
    {
        // Nothing embedded (an image built without database/migrations/) would read as "ok" for
        // any schema; fail instead, so the probe reports "unknown" and 503.
        if (Known.Count == 0)
            throw new InvalidOperationException("No migrations embedded in this build (Api.csproj, Api.Dockerfile)");
        var hasLedger = await db.Database
            .SqlQueryRaw<bool>("""SELECT to_regclass('public.schema_migrations') IS NOT NULL AS "Value" """)
            .SingleAsync(ct);
        var applied = hasLedger
            ? await db.Database.SqlQueryRaw<int>("""SELECT version AS "Value" FROM public.schema_migrations""").ToListAsync(ct)
            : [];
        return Pending(Known, applied);
    }

    private const string HasLedger = "SELECT to_regclass('public.schema_migrations') IS NOT NULL";
    private const string AppliedVersions = "SELECT version FROM public.schema_migrations";

    /// <summary><see cref="V2Known"/> migrations the V2 ledger does not list; a plain connection, since V2 has no EF.</summary>
    public static async Task<List<string>> V2PendingAsync(NpgsqlConnection conn, CancellationToken ct = default)
    {
        if (V2Known.Count == 0)
            throw new InvalidOperationException("No V2 migrations embedded in this build (Api.csproj, Api.Dockerfile)");
        var applied = new List<int>();
        await using (var hasLedger = new NpgsqlCommand(HasLedger, conn))
            if (!(bool)(await hasLedger.ExecuteScalarAsync(ct))!)
                return Pending(V2Known, applied);
        await using var versions = new NpgsqlCommand(AppliedVersions, conn);
        await using var reader = await versions.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) applied.Add(reader.GetInt32(0));
        return Pending(V2Known, applied);
    }

    /// <summary>"0007_add_x" is pending unless version 7 is applied.</summary>
    public static List<string> Pending(IEnumerable<string> known, IEnumerable<int> applied)
    {
        var done = applied.ToHashSet();
        return known.Where(k => !done.Contains(int.Parse(k[..k.IndexOf('_')]))).ToList();
    }
}
