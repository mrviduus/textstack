using System.Runtime.CompilerServices;
using Application.Common.Interfaces;
using Dapper;
using Infrastructure.Persistence.Repositories;
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
#pragma warning disable CA2255 // deliberate: this assembly is the app's persistence layer, not a reusable library
    [ModuleInitializer]
    internal static void ConfigureDapper() => DefaultTypeMap.MatchNamesWithUnderscores = true;
#pragma warning restore CA2255

    public static NpgsqlDataSource Create(string connectionString)
    {
        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.UseVector();
        return builder.Build();
    }

    /// <summary>
    /// The data source as a singleton (DI disposes it, and its pool, on shutdown) and the Dapper
    /// repositories on it. Singletons: a repository holds nothing but the data source.
    /// </summary>
    public static IServiceCollection AddTextStackDataAccess(this IServiceCollection services, string connectionString) =>
        services
            .AddSingleton(_ => Create(connectionString))
            .AddSingleton<IInsightRepository, InsightRepository>();
}
