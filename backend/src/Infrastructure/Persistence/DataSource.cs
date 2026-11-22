using System.Data;
using System.Runtime.CompilerServices;
using Application.Annotations;
using Application.Common;
using Application.Discussion;
using Application.Identity;
using Application.Library;
using Application.AdminSettings;
using Application.Reading;
using Application.Transitional;
using Application.Vocabulary;
using Dapper;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// Dapper settings and the V2 repositories (ADR-028, docs/architecture/data-access.md).
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

    /// <summary>The database's connection string: <c>ConnectionStrings:Default</c>, null when unset.</summary>
    public static string? AppConnectionString(this IConfiguration configuration) =>
        configuration.GetConnectionString("Default")
        ?? configuration.GetConnectionString("V2"); // fallback: drop after #1440 2b

    /// <summary>
    /// The data source as a singleton (DI disposes it, and its pool, on shutdown) and the Dapper
    /// repositories on it. Singletons: a repository holds nothing but its data source. Nothing opens a
    /// connection before first use (data-access.md rule 5).
    /// </summary>
    public static IServiceCollection AddTextStackDataAccess(this IServiceCollection services, string? connectionString) =>
        services
            .AddSingleton(_ => new AppDataSource(connectionString))
            .AddSingleton<IUnitOfWork>(sp => sp.GetRequiredService<AppDataSource>())
            .AddSingleton<ILibraryRepository, LibraryRepository>()
            .AddSingleton<IReadingStateRepository, ReadingStateRepository>()
            .AddSingleton<IReadingSessionRepository, ReadingSessionRepository>()
            .AddSingleton<IAnnotationRepository, AnnotationRepository>()
            .AddSingleton<IVocabularyRepository, VocabularyRepository>()
            .AddSingleton<ISharedChapterRepository, SharedChapterRepository>()
            .AddSingleton<ICheckpointRepository, CheckpointRepository>()
            .AddSingleton<IBookInsightRepository, BookInsightRepository>()
            .AddSingleton<IReviewQuestionRepository, ReviewQuestionRepository>()
            .AddSingleton<UserRepository>()
            .AddSingleton<IUserRepository>(sp => sp.GetRequiredService<UserRepository>())
            .AddSingleton<IAccountMergeRepository, AccountMergeRepository>()
            .AddSingleton<LlmTraceWriter>()
            .AddSingleton<AgentRunWriter>()
            .AddSingleton<IAdminSettingsRepository, AdminSettingsRepository>()
            .AddSingleton<IBookChapterRepository, BookChapterRepository>()
            .AddSingleton<IIngestionJobRepository, IngestionJobRepository>();
}
