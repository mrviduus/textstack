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
