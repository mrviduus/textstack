using Application.Identity;
using Application.Common.Interfaces;
using Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Tts;
using TextStack.Vocabulary;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Content + product services: vocabulary SRS, image optimization, email,
    /// the shared HttpClient, and TTS (incl. its startup-cleanup hosted service).
    /// </summary>
    public static IServiceCollection AddTextStackContentServices(
        this IServiceCollection services, IConfiguration configuration)
    {
        // Vocabulary SRS library
        services.AddTextStackVocabulary();

        // Image optimization
        services.AddSingleton<IImageOptimizer, ImageOptimizer>();

        // Email (Resend)
        services.Configure<EmailSettings>(options =>
        {
            options.ResendApiKey = configuration["Resend:ApiKey"] ?? "";
            options.FromEmail = configuration["Resend:FromEmail"] ?? "noreply@textstack.app";
            options.BaseUrl = PublicSite.BaseUrl(configuration);
            options.AdminAlertEmail = configuration["Resend:AdminAlertEmail"] ?? "";
        });
        // No retries: a POST retried without an idempotency key sends the email twice.
        services.AddHttpClient<IEmailService, ResendEmailService>(http => http.Timeout = TimeSpan.FromSeconds(10));

        // HttpClient for translation proxy
        services.AddHttpClient();

        // TTS
        services.Configure<TtsConfiguration>(configuration.GetSection("Tts"));
        services.AddSingleton<ITtsService, EdgeTtsService>();
        services.AddHostedService(sp => (EdgeTtsService)sp.GetRequiredService<ITtsService>());

        return services;
    }
}
