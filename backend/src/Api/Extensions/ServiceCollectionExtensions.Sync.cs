using Api.Sync;
using Application.Annotations;
using Application.Discussion;
using Application.Identity;
using Application.Library;
using Application.Reading;
using Application.Vocabulary;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// The /me/v2 use cases and their readiness gate. Nothing here touches <c>textstack_v2</c> until a V2 route or
    /// <c>/health/ready</c> asks (data-access.md rule 5).
    /// </summary>
    public static IServiceCollection AddTextStackSyncApi(this IServiceCollection services) =>
        services
            // An unbindable request throws to ExceptionMiddleware (which answers V2 clients
            // invalid_payload) instead of a bare 400. For every route, as Development already did.
            .Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true)
            .AddSingleton<SyncReadiness>()
            .AddSingleton<LibrarySyncService>()
            .AddSingleton<LibraryContentService>()
            .AddSingleton<Application.Transitional.ChapterReadService>()
            .AddSingleton<ReadingSyncService>()
            .AddSingleton<AnnotationSyncService>()
            .AddSingleton<VocabularySyncService>()
            .AddSingleton<DiscussionSyncService>()
            .AddSingleton<InsightSyncService>()
            .AddSingleton<ClipService>();
}
