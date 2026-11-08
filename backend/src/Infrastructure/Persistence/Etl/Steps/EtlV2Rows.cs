using System.Globalization;
using System.Text.Json;
using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// What the mappers share: a mapped row and the target's are compared by value (every column, arrays and
/// jsonb text included), and each mapped row is new, unchanged or different from what the target holds.
/// jsonb is compared as Postgres prints it, so a mapper builds its JSON in SQL, never in C#.
/// </summary>
internal static class EtlV2Rows
{
    private static readonly JsonSerializerOptions Json = new();

    public static bool Same<T>(T a, T b) => JsonSerializer.Serialize(a, Json) == JsonSerializer.Serialize(b, Json);

    /// <summary>Rows from legacy, in the run's snapshot.</summary>
    public static async Task<List<T>> SourceAsync<T>(EtlV2Context context, string sql, object? args, CancellationToken ct) =>
        (await context.Source.Connection!.QueryAsync<T>(new CommandDefinition(sql, args, context.Source, cancellationToken: ct))).AsList();

    /// <summary>Rows from <c>textstack_v2</c>, outside any write: what is there now.</summary>
    public static async Task<List<T>> TargetAsync<T>(EtlV2Context context, string sql, object? args, CancellationToken ct)
    {
        await using var conn = await context.Target.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct))).AsList();
    }

    public static EtlV2Plan<T> Classify<T, TKey>(IEnumerable<T> expected, IEnumerable<T> actual, Func<T, TKey> key) where TKey : notnull
    {
        var existing = actual.ToDictionary(key);
        var plan = new EtlV2Plan<T>();
        foreach (var row in expected)
        {
            if (!existing.TryGetValue(key(row), out var current))
                plan.New.Add(row);
            else if (Same(row, current))
                plan.Unchanged++;
            else
                plan.Different.Add(row);
        }
        return plan;
    }

    /// <summary>
    /// The mapped rows against the target. A V2 row that differs is updated (<paramref name="updateDifferent"/>) or
    /// a failed check, never overwritten. A V2 row with no mapped row is a cleanup line, never deleted:
    /// <paramref name="orphanLine"/>'s, or the generic one.
    /// </summary>
    public static EtlV2Plan<T> Plan<T, TKey>(EtlV2Context context, string table, IEnumerable<T> expected, IEnumerable<T> actual, Func<T, TKey> key,
        bool updateDifferent = false, Func<T, string>? orphanLine = null)
        where TKey : notnull
    {
        var mapped = expected.Select(key).ToHashSet();
        foreach (var orphan in actual.Where(r => !mapped.Contains(key(r))).OrderBy(r => key(r).ToString(), StringComparer.Ordinal))
            context.CleanupActions.Add(orphanLine?.Invoke(orphan) ?? $"{table} {key(orphan)}: V2 row with no legacy row; not deleted, a human reviews it");
        var plan = Classify(expected, actual, key);
        if (!updateDifferent)
            Check(context, $"{table}: V2 row differs from its legacy mapping", plan.Different.Select(r => key(r).ToString()!));
        context.Writes[table] = new(plan.New.Count, updateDifferent ? plan.Different.Count : 0, plan.Unchanged);
        return plan;
    }

    /// <summary>After the write: every mapped row is in V2 as mapped, every column (owner included) compared.</summary>
    public static void Verify<T, TKey>(EtlV2Context context, string name, IEnumerable<T> expected, IEnumerable<T> actual, Func<T, TKey> key)
        where TKey : notnull
    {
        var after = Classify(expected, actual, key);
        Check(context, name, after.New.Concat(after.Different).Select(r => key(r).ToString()!));
    }

    /// <summary>A unique value of a row to write that V2 holds under another id: "{name} held by another V2 id", as row/holder. Null values hold nothing.</summary>
    public static void HeldByAnother<T, TKey>(EtlV2Context context, string name, IEnumerable<T> rows, IEnumerable<T> v2, Func<T, Guid> id, Func<T, TKey?> value)
    {
        var holders = v2.Where(r => value(r) is not null).ToLookup(r => value(r)!, id);
        Check(context, $"{name} held by another V2 id", rows.Where(r => value(r) is not null)
            .SelectMany(r => holders[value(r)!].Where(holder => holder != id(r)).Select(holder => $"{id(r)}/{holder}")));
    }

    /// <summary>Rows sharing a non-null key, each group as "id1/id2/…".</summary>
    public static IEnumerable<string> Duplicates<T, TKey>(IEnumerable<T> rows, Func<T, TKey?> key, Func<T, Guid> id) =>
        rows.Where(r => key(r) is not null).GroupBy(r => key(r)!).Where(g => g.Count() > 1).Select(g => string.Join("/", g.Select(id)));

    /// <summary>
    /// The rows no rule refuses. Each rule is a check, <c>"{table}: {rule}"</c>, failing with the ids it refuses:
    /// a row V2's CHECKs or FKs would abort on is refused whole, never carried half or dropped silently.
    /// </summary>
    public static List<T> Admit<T>(EtlV2Context context, string table, IEnumerable<T> rows, Func<T, Guid> id, params (string Rule, Func<T, bool> Refused)[] rules)
    {
        var list = rows.ToList();
        foreach (var (rule, refused) in rules)
            Check(context, $"{table}: {rule}", list.Where(refused).Select(r => id(r).ToString()));
        return [.. list.Where(r => !rules.Any(x => x.Refused(r)))];
    }

    /// <summary>
    /// A legacy <c>double precision</c> as V2's <c>numeric</c>: its shortest round-trip digits (Postgres's own
    /// cast keeps 15), so the stored value and the one a check compares are the same decimal.
    /// </summary>
    public static decimal Numeric(double value) =>
        decimal.Parse(value.ToString("R", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary>A check whose failures are <paramref name="ids"/> (ids only, never content).</summary>
    public static void Check(EtlV2Context context, string name, IEnumerable<string> ids)
    {
        string[] failed = [.. ids];
        context.Checks.Add(new(name, failed.Length, failed.Length == 0 ? null : failed));
    }
}

/// <summary>The mapped rows of one target table against what it holds.</summary>
internal sealed class EtlV2Plan<T>
{
    public List<T> New { get; } = [];

    public List<T> Different { get; } = [];

    public int Unchanged { get; set; }
}
