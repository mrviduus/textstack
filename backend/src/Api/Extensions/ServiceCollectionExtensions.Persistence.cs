using Application.Common.Interfaces;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Core persistence: ICurrentSite, AppDbContext (Npgsql + pgvector + snake_case),
    /// the IAppDbContext facade, and local file storage.
    /// R1a: ICurrentSite MUST stay registered before AddDbContext.
    /// </summary>
    public static IServiceCollection AddTextStackPersistence(
        this IServiceCollection services, string connectionString, IConfiguration configuration)
    {
        services.AddSingleton<ICurrentSite>(
            sp => new CurrentSite(sp.GetRequiredService<IConfiguration>()));

        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(connectionString, o => o.UseVector())
                .UseSnakeCaseNamingConvention()
                .ConfigureWarnings(w => w
                    .Ignore(RelationalEventId.PendingModelChangesWarning)
                    // Ten of these fire at every startup, in production too: Edition,
                    // Author and SsgRebuildJob carry the site query filter and are the
                    // required end of relationships with BookAsset, BookFile, Chapter,
                    // ChapterChunk, EditionAuthor, IngestionJob, LintResult
                    // and SsgRebuildResult.
                    //
                    // The hazard EF is describing — a required principal filtered out,
                    // leaving dependents with nowhere to point — cannot occur here. The
                    // filter is `x.SiteId == _currentSite.Id`, and ADR-007 makes this a
                    // single-site deployment with one fixed SiteConstants.DefaultSiteId,
                    // so it excludes no row that exists.
                    //
                    // Silenced rather than restructured, because ten lines of unactionable
                    // warning at every boot is how a real warning goes unread. If
                    // multi-site ever returns, delete this line first: the warnings become
                    // accurate the moment a second site exists.
                    .Ignore(CoreEventId.PossibleIncorrectRequiredNavigationWithQueryFilterInteractionWarning)));

        services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());

        // File storage
        var storagePath = configuration["Storage:RootPath"] ?? "/storage";
        services.AddSingleton<IFileStorageService>(new LocalFileStorageService(storagePath));

        return services;
    }
}
