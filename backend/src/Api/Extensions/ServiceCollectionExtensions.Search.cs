using Application.Search;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TextStack.Search;
using TextStack.Search.Meilisearch;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Search stack: the TextStack.Search library, the configured provider
    /// (Postgres FTS default / Meilisearch), the CLI reindex service, and the
    /// embedding-backed similar-books + hybrid-catalog services.
    /// </summary>
    public static IServiceCollection AddTextStackSearchStack(
        this IServiceCollection services, string connectionString, IConfiguration configuration)
    {
        // Search library
        services.AddTextStackSearch();
        var searchProvider = configuration["Search:Provider"] ?? "postgres";
        if (searchProvider == "meilisearch")
            services.AddMeilisearchProvider(options =>
                configuration.GetSection("Search:Meilisearch").Bind(options));
        else
            services.AddPostgresFtsProvider(
                _ => () => new NpgsqlConnection(connectionString),
                options => options.ConnectionString = connectionString);

        // Reindex service (used by CLI)
        services.AddScoped<SearchReindexService>();

        return services;
    }
}
