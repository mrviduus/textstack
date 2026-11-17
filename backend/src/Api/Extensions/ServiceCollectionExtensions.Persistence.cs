using Infrastructure.Persistence;
using Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>Core persistence: the V2 data source and its Dapper repositories (ADR-028), identity, and file storage.</summary>
    public static IServiceCollection AddTextStackPersistence(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddTextStackDataAccess(configuration.GetConnectionString("V2"))
            .AddIdentityPorts()
            .AddTextStackAuthentication();

        services.AddTextStackFileStores(configuration);

        return services;
    }
}
