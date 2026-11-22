using Microsoft.Extensions.Logging;
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
            .AddSingleton<AccountDeletion>()
            .AddSingleton<ISessionTokenRepository, SessionTokenRepository>()
            .AddSingleton<IOAuthRepository, OAuthRepository>()
            .AddSingleton<IDeviceLoginRepository, DeviceLoginRepository>()
            .AddSingleton<IMcpKeyRepository, McpKeyRepository>()
            .AddSingleton<ILlmTraceWriter>(sp => sp.GetRequiredService<LlmTraceWriter>())
            // The daily AI budgets seed from the traces where they are written (RollingSpendTracker).
            .AddSingleton<Application.Ai.ILlmSpendSource>(sp => sp.GetRequiredService<LlmTraceWriter>())
            .AddSingleton<IAgentRunWriter>(sp => sp.GetRequiredService<AgentRunWriter>());

    /// <summary>The Api's auth services.</summary>
    public static IServiceCollection AddTextStackAuthentication(this IServiceCollection services)
    {
        services.TryAddSingleton(sp => new JwtTokens(sp.GetRequiredService<IOptions<JwtSettings>>().Value,
            sp.GetRequiredService<TimeProvider>(), sp.GetService<ILogger<JwtTokens>>()));
        services.TryAddSingleton(sp => new ProviderTokens(sp.GetRequiredService<IOptions<GoogleSettings>>().Value,
            sp.GetRequiredService<IOptions<AppleSettings>>().Value, logger: sp.GetService<ILogger<ProviderTokens>>()));
        services.AddScoped<IAuthService, AuthService>();
        services.AddScoped<IAdminAuthService, AdminAuthService>();
        return services;
    }
}
