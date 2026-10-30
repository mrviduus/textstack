using Microsoft.EntityFrameworkCore;

namespace Api.Extensions;

/// <summary>
/// Postgres records which version of the OS collation rules each database was created under, and
/// the `db` image can change that version without anyone asking: a digest bump inside one Postgres
/// major can move the base distribution, and with it glibc. Text then sorts by rules the indexes
/// were not built with — a btree lookup walks past rows that are there, and a UNIQUE index stops
/// seeing a duplicate. Postgres mentions it once, as a WARNING in a log nobody reads.
///
/// On 2026-10-30 the production cluster was found with `template1` and `postgres` recording glibc
/// 2.41 against an image providing 2.36, true since its own initdb, while the application database
/// matched. A mismatched `template1` cannot be copied, so `CREATE DATABASE` fails cluster-wide —
/// which is how it was finally noticed, by taking the API down for 44 minutes
/// (docs/incidents/2026-10-30-migrator-v2-took-down-the-api.md).
/// </summary>
internal static class CollationDrift
{
    /// <summary>
    /// One line per database whose recorded collation version is not the one the OS provides now,
    /// empty when the cluster agrees with itself.
    ///
    /// Every database, not the current one: the drift that blocks `CREATE DATABASE` lives in
    /// `template1`, which no connection of ours ever uses. `template0` and any C/POSIX locale
    /// record no version at all and cannot drift, so they are left out rather than reported as a
    /// third state nobody can act on.
    /// </summary>
    public static Task<List<string>> DriftedAsync(DbContext db, CancellationToken ct = default) =>
        db.Database.SqlQueryRaw<string>(
            """
            SELECT datname || ': created under ' || datcollversion || ', OS now provides '
                     || coalesce(pg_database_collation_actual_version(oid), 'no version') AS "Value"
            FROM pg_database
            WHERE datcollversion IS NOT NULL
              AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
            ORDER BY datname
            """).ToListAsync(ct);
}
