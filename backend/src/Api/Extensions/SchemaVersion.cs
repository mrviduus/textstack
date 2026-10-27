using Microsoft.EntityFrameworkCore;

namespace Api.Extensions;

/// <summary>
/// The `migrator` compose service owns the schema (ADR-021, ADR-026); the Api never migrates, it
/// only checks. A schema behind this build — after <c>migrate.sh down</c>, or a migrator that did
/// not run — is reported (Critical log at start, <c>/health/ready</c> 503), never fatal.
/// </summary>
internal static class SchemaVersion
{
    private const string Prefix = "migrations/";
    private const string Suffix = ".up.sql";

    /// <summary>The migrations this build was written against, oldest first: "0000_baseline", …
    /// Embedded from <c>database/migrations/</c> at build time (Api.csproj).</summary>
    public static readonly IReadOnlyList<string> Known = typeof(SchemaVersion).Assembly.GetManifestResourceNames()
        .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal) && n.EndsWith(Suffix, StringComparison.Ordinal))
        .Select(n => n[Prefix.Length..^Suffix.Length])
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

    /// <summary>"0007_add_x" is pending unless version 7 is applied.</summary>
    public static List<string> Pending(IEnumerable<string> known, IEnumerable<int> applied)
    {
        var done = applied.ToHashSet();
        return known.Where(k => !done.Contains(int.Parse(k[..k.IndexOf('_')]))).ToList();
    }
}
