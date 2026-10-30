using System.Data;
using System.Runtime.CompilerServices;
using Application.Annotations;
using Application.Common.Interfaces;
using Application.Library;
using Application.Reading;
using Application.Vocabulary;
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
    /// Process-wide Dapper settings: snake_case columns map to PascalCase properties without aliases,
    /// and <see cref="DateTimeOffset"/> parameters are written as UTC. A module initializer, so they
    /// hold however a connection is built (tests, CLI), not only here.
    /// </summary>
#pragma warning disable CA2255 // deliberate: this assembly is the app's persistence layer, not a reusable library
    [ModuleInitializer]
    internal static void ConfigureDapper()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;
        // Dapper's built-in map wins over a handler, so it has to go first.
        SqlMapper.RemoveTypeMap(typeof(DateTimeOffset));
        SqlMapper.RemoveTypeMap(typeof(DateTimeOffset?));
        SqlMapper.AddTypeHandler(new UtcDateTimeOffsetHandler());
    }
#pragma warning restore CA2255

    /// <summary>
    /// Npgsql writes <c>timestamptz</c> only from offset-0 values and throws on any other, so a
    /// client time like <c>12:00+02:00</c> is converted here, once, instead of in every repository.
    /// </summary>
    private sealed class UtcDateTimeOffsetHandler : SqlMapper.TypeHandler<DateTimeOffset>
    {
        public override void SetValue(IDbDataParameter parameter, DateTimeOffset value) =>
            parameter.Value = value.ToUniversalTime();

        // Npgsql reads timestamptz as a UTC DateTime; a plain timestamp (Unspecified) is stored UTC here too.
        public override DateTimeOffset Parse(object value) =>
            value is DateTime utc ? new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)) : (DateTimeOffset)value;
    }

    public static NpgsqlDataSource Create(string connectionString)
    {
        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.UseVector();
        return builder.Build();
    }

    /// <summary>
    /// The data sources as singletons (DI disposes them, and their pools, on shutdown) and the Dapper
    /// repositories on them. Singletons: a repository holds nothing but its data source. The V2 side
    /// is built on first use only (data-access.md rule 5).
    /// </summary>
    public static IServiceCollection AddTextStackDataAccess(
        this IServiceCollection services, string connectionString, string? v2ConnectionString) =>
        services
            .AddSingleton(_ => Create(connectionString))
            .AddSingleton<IInsightRepository, InsightRepository>()
            .AddSingleton(_ => new V2DataSource(
                v2ConnectionString ?? throw new InvalidOperationException("ConnectionStrings:V2 is not set")))
            .AddSingleton<ILibraryRepository, LibraryRepository>()
            .AddSingleton<IReadingStateRepository, ReadingStateRepository>()
            .AddSingleton<IAnnotationRepository, AnnotationRepository>()
            .AddSingleton<IVocabularyRepository, VocabularyRepository>();
}
