using Microsoft.Extensions.Logging;
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
    /// <summary>Shared by Api and Worker: the identity ports and the AI trace writers on V2.</summary>
    public static IServiceCollection AddIdentityPorts(this IServiceCollection services) =>
        services
            .AddSingleton<V2AccountDeletion>()
            .AddSingleton<ISessionTokenRepository, SessionTokenRepository>()
            .AddSingleton<IOAuthRepository, OAuthRepository>()
            .AddSingleton<IDeviceLoginRepository, DeviceLoginRepository>()
            .AddSingleton<IMcpKeyRepository, McpKeyRepository>()
            .AddSingleton<ILlmTraceWriter>(sp => sp.GetRequiredService<V2LlmTraceWriter>())
            // The daily AI budgets seed from the traces where they are written (RollingSpendTracker).
            .AddSingleton<Application.Ai.ILlmSpendSource>(sp => sp.GetRequiredService<V2LlmTraceWriter>())
            .AddSingleton<IAgentRunWriter>(sp => sp.GetRequiredService<V2AgentRunWriter>());

    /// <summary>The Api's auth services.</summary>
    public static IServiceCollection AddTextStackAuthentication(this IServiceCollection services)
    {
        services.TryAddSingleton(sp => new JwtTokens(sp.GetRequiredService<IOptions<JwtSettings>>().Value,
            sp.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton(sp => new ProviderTokens(sp.GetRequiredService<IOptions<GoogleSettings>>().Value,
            sp.GetRequiredService<IOptions<AppleSettings>>().Value, logger: sp.GetService<ILogger<ProviderTokens>>()));
        services.AddScoped<IAuthService, V2AuthService>();
        services.AddScoped<IAdminAuthService, V2AdminAuthService>();
        return services;
    }
}
