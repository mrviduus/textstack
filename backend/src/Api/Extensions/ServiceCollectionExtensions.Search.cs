using Npgsql;
using TextStack.Search;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Search stack: the TextStack.Search library + the Postgres FTS provider.
    /// </summary>
    public static IServiceCollection AddTextStackSearchStack(this IServiceCollection services, string connectionString)
    {
        services.AddTextStackSearch();
        services.AddPostgresFtsProvider(
            _ => () => new NpgsqlConnection(connectionString),
            options => options.ConnectionString = connectionString);

        return services;
    }
}
