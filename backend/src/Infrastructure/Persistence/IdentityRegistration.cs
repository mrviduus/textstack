using Application.AdminAuth;
using Application.Auth;
using Application.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using TextStack.Ai.Core;

namespace Infrastructure.Persistence;

public static class IdentityRegistration
{
    /// <summary>Shared by Api and Worker: every identity port selects the same database.</summary>
    public static IServiceCollection AddSelectedIdentityPorts(this IServiceCollection services, DatabaseMode mode)
    {
        services.AddSingleton(mode);
        if (!mode.IsV2) return services.AddLegacyIdentityPorts();

        services.RemoveAll<IUserRepository>();
        services.RemoveAll<ISessionTokenRepository>();
        services.RemoveAll<IOAuthRepository>();
        services.RemoveAll<IDeviceLoginRepository>();
        services.RemoveAll<IMcpKeyRepository>();
        // Worker has no HTTP auth surface. Api adds the selected auth services explicitly below;
        // a new Worker consumer must not accidentally resolve a legacy session service in V2 mode.
        services.RemoveAll<IAuthService>();
        services.RemoveAll<IAdminAuthService>();
        services.AddSingleton<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
        services.AddSingleton<ISessionTokenRepository, SessionTokenRepository>();
        services.AddSingleton<IOAuthRepository, OAuthRepository>();
        services.AddSingleton<IDeviceLoginRepository, DeviceLoginRepository>();
        services.AddSingleton<IMcpKeyRepository, McpKeyRepository>();
        services.RemoveAll<ILlmTraceWriter>();
        services.RemoveAll<IAgentRunWriter>();
        services.AddSingleton<ILlmTraceWriter>(sp => sp.GetRequiredService<V2LlmTraceWriter>());
        services.AddSingleton<IAgentRunWriter>(sp => sp.GetRequiredService<V2AgentRunWriter>());
        return services;
    }

    /// <summary>The Api's existing auth contracts, selected together after application registration.</summary>
    public static IServiceCollection AddSelectedAuthentication(this IServiceCollection services, DatabaseMode mode)
    {
        if (!mode.IsV2) return services;

        services.TryAddSingleton(sp => new JwtTokens(sp.GetRequiredService<IOptions<JwtSettings>>().Value,
            sp.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton(sp => new ProviderTokens(sp.GetRequiredService<IOptions<GoogleSettings>>().Value,
            sp.GetRequiredService<IOptions<AppleSettings>>().Value));
        services.RemoveAll<IAuthService>();
        services.RemoveAll<IAdminAuthService>();
        services.AddScoped<IAuthService, V2AuthService>();
        services.AddScoped<IAdminAuthService, V2AdminAuthService>();
        return services;
    }
}
