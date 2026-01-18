using Application.Admin;
using Application.Auth;
using Application.Books;
using Application.Reprocessing;
using Application.Seo;
using Application.SeoCrawl;
using Application.Sites;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<BookService>();
        services.AddScoped<SeoService>();
        services.AddScoped<AdminService>();
        services.AddScoped<SiteService>();
        services.AddScoped<Ingestion.IngestionService>();
        services.AddScoped<AuthService>();
        services.AddScoped<ReprocessingService>();
        services.AddScoped<SeoCrawlService>();
        return services;
    }

    public static IServiceCollection AddAuthSettings(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<JwtSettings>(configuration.GetSection(JwtSettings.SectionName));
        services.Configure<GoogleSettings>(configuration.GetSection(GoogleSettings.SectionName));
        return services;
    }
}
