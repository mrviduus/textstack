using Npgsql;
using TextStack.Search;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Search stack: the TextStack.Search library + the Postgres FTS provider, on the shared
    /// NpgsqlDataSource (registered by AddTextStackPersistence).
    /// </summary>
    public static IServiceCollection AddTextStackSearchStack(this IServiceCollection services)
    {
        services.AddTextStackSearch();
        services.AddPostgresFtsProvider(
            sp => sp.GetRequiredService<NpgsqlDataSource>().CreateConnection);

        return services;
    }
}
