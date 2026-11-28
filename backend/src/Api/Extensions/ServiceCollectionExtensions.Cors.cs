using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>Default CORS policy — origins from Cors:AllowedOrigins with a dev/prod fallback list.</summary>
    public static IServiceCollection AddTextStackCors(this IServiceCollection services, IConfiguration configuration)
    {
        var corsOrigins = configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
            ?? [
                "http://localhost:5173", "http://general.localhost", "http://general.localhost:5173",
                "http://localhost:81", "http://admin.localhost", "http://admin.localhost:81",
                "https://textstack.app", "https://textstack.dev",
                // The Android shell's WebView (apps/android, ADR-035): its page runs at https://localhost and
                // calls the API with a bearer. A browser cannot reach a page at that origin on another machine.
                "https://localhost"
            ];
        services.AddCors(options =>
        {
            options.AddDefaultPolicy(policy =>
            {
                policy.WithOrigins(corsOrigins)
                    .AllowAnyHeader()
                    .AllowAnyMethod()
                    .AllowCredentials()
                    // A cross-origin range read needs it; dev/CI call the API cross-origin.
                    .WithExposedHeaders("Content-Range");
            });
        });
        return services;
    }
}
