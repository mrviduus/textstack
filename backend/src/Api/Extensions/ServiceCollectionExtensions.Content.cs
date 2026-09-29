using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Application.TextStack;
using Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Tts;
using TextStack.Vocabulary;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Content + product services: vocabulary SRS, image optimization, site
    /// resolution, TextStack/Standard Ebooks import, user-book services, email,
    /// the shared HttpClient, and TTS (incl. its startup-cleanup hosted service).
    /// </summary>
    public static IServiceCollection AddTextStackContentServices(
        this IServiceCollection services, IConfiguration configuration)
    {
        // Vocabulary SRS library
        services.AddTextStackVocabulary(options =>
        {
            options.OllamaBaseUrl = configuration["Ollama:BaseUrl"] ?? "http://localhost:11434";
            options.OllamaModel = configuration["Ollama:Model"] ?? "gemma4:e2b";
            options.OllamaTimeoutSeconds = configuration.GetValue("Ollama:TimeoutSeconds", 30);
        });

        // Image optimization
        services.AddSingleton<IImageOptimizer, ImageOptimizer>();

        // Site resolution
        services.AddMemoryCache();
        services.AddSingleton<ISiteResolver, SiteResolver>();

        // TextStack import
        services.AddScoped<TextStackImportService>();

        // User books
        services.AddScoped<Application.UserBooks.UserBookService>();
        services.AddScoped<Application.UserBooks.MetadataService>();
        services.AddScoped<Application.UserBooks.TagService>();
        services.AddScoped<Application.Collections.CollectionService>();
        services.AddScoped<Application.UserBooks.BulkActionService>();
        services.AddScoped<Application.UserBooks.BookStatsService>();
        services.AddScoped<Application.UserBooks.UserBookSearchService>();
        services.AddScoped<Application.Library.LibraryShelvesService>();

        // Chapter review (docs/05-features/chapter-review.md)
        services.AddScoped<Application.ChapterReview.ChapterReviewService>();
        services.AddScoped<Application.ChapterReview.ReviewQuestionService>();

        // Standard Ebooks sync
        services.AddHttpClient<StandardEbooksSyncService>();
        services.AddScoped<StandardEbooksSyncService>();

        // Email (Resend)
        services.Configure<EmailSettings>(options =>
        {
            options.ResendApiKey = configuration["Resend:ApiKey"] ?? "";
            options.FromEmail = configuration["Resend:FromEmail"] ?? "noreply@textstack.app";
            options.BaseUrl = configuration["App:BaseUrl"] ?? "https://textstack.app";
            options.AdminAlertEmail = configuration["Resend:AdminAlertEmail"] ?? "";
        });
        services.AddHttpClient<IEmailService, ResendEmailService>();

        // HttpClient for translation proxy
        services.AddHttpClient();

        // TTS
        services.Configure<TtsConfiguration>(configuration.GetSection("Tts"));
        services.AddSingleton<ITtsService, EdgeTtsService>();
        services.AddHostedService(sp => (EdgeTtsService)sp.GetRequiredService<ITtsService>());

        return services;
    }
}
