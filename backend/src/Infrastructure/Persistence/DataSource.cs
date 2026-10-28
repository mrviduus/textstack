using System.Runtime.CompilerServices;
using Dapper;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Pgvector.Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// The one <see cref="NpgsqlDataSource"/> a process talks to Postgres through — EF Core, Dapper
/// repositories and search share its pool and its type mapping (ADR-028, docs/01-architecture/data-access.md).
/// </summary>
public static class DataSource
{
    /// <summary>
    /// Process-wide Dapper setting: snake_case columns map to PascalCase properties without aliases.
    /// A module initializer, so it holds however a connection is built (tests, CLI), not only here.
    /// </summary>
    [ModuleInitializer]
    internal static void ConfigureDapper() => DefaultTypeMap.MatchNamesWithUnderscores = true;

    public static NpgsqlDataSource Create(string connectionString)
    {
        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.UseVector();
        return builder.Build();
    }

    /// <summary>Registers the data source as a singleton; DI disposes it (and its pool) on shutdown.</summary>
    public static IServiceCollection AddTextStackDataSource(this IServiceCollection services, string connectionString) =>
        services.AddSingleton(_ => Create(connectionString));
}
