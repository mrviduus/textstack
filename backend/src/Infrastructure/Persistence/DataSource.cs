using System.Runtime.CompilerServices;
using Application.Common.Interfaces;
using Application.Library;
using Application.Reading;
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
    /// <para>The V2 data source and its repositories are registered only when
    /// <paramref name="v2ConnectionString"/> is set (<c>ConnectionStrings:V2</c>), and are built on
    /// first use, which opens no connection either: V1 must keep serving while V2 is broken
    /// (ADR-030 decision 1, amended).</para>
    /// </summary>
    public static IServiceCollection AddTextStackDataAccess(
        this IServiceCollection services, string connectionString, string? v2ConnectionString)
    {
        services
            .AddSingleton(_ => Create(connectionString))
            .AddSingleton<IInsightRepository, InsightRepository>();
        if (!string.IsNullOrEmpty(v2ConnectionString))
            services
                .AddSingleton(_ => new V2DataSource(v2ConnectionString))
                .AddSingleton<ILibraryRepository, LibraryRepository>()
                .AddSingleton<IReadingStateRepository, ReadingStateRepository>();
        return services;
    }
}
