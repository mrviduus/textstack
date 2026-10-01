using System.Data;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TextStack.Search.Abstractions;
using TextStack.Search.Analyzers;
using TextStack.Search.Configuration;
using TextStack.Search.Providers.PostgresFts;

namespace TextStack.Search;

/// <summary>
/// Extension methods for configuring search services.
/// </summary>
public static class DependencyInjection
{
    /// <summary>
    /// Adds core search services to the service collection.
    /// </summary>
    public static IServiceCollection AddTextStackSearch(
        this IServiceCollection services,
        Action<SearchOptions>? configureOptions = null)
    {
        // Configure search options
        if (configureOptions != null)
        {
            services.Configure(configureOptions);
        }
        else
        {
            services.Configure<SearchOptions>(_ => { });
        }

        // Register core services
        services.AddSingleton<ITextAnalyzer, MultilingualAnalyzer>();
        services.AddSingleton<IQueryBuilder, TsQueryBuilder>();
        services.AddSingleton<IHighlighter, PostgresHighlighter>();

        return services;
    }

    /// <summary>
    /// Adds PostgreSQL FTS provider with a custom connection factory.
    /// Useful when sharing the connection with Entity Framework.
    /// </summary>
    public static IServiceCollection AddPostgresFtsProvider(
        this IServiceCollection services,
        Func<IServiceProvider, Func<IDbConnection>> connectionFactoryBuilder,
        Action<PostgresFtsOptions>? configureOptions = null)
    {
        // Configure PostgreSQL FTS options
        if (configureOptions != null)
        {
            services.Configure(configureOptions);
        }
        else
        {
            services.Configure<PostgresFtsOptions>(_ => { });
        }

        // Register custom connection factory
        services.AddSingleton(connectionFactoryBuilder);

        // Register search provider
        services.AddSingleton<ISearchProvider>(sp =>
        {
            var connectionFactory = connectionFactoryBuilder(sp);
            var queryBuilder = sp.GetRequiredService<IQueryBuilder>();
            var textAnalyzer = sp.GetRequiredService<ITextAnalyzer>();
            var options = sp.GetRequiredService<IOptions<PostgresFtsOptions>>().Value;

            return new PostgresSearchProvider(
                connectionFactory,
                queryBuilder,
                textAnalyzer,
                options.Highlights,
                options.FuzzyThreshold);
        });

        return services;
    }
}
