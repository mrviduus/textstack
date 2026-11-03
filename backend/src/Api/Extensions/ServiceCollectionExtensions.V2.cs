using Api.V2;
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
    /// The /me/v2 use cases, their readiness gate, the shadow-user bridge and the identity mirror. Registered whatever
    /// <c>Features:V2Api</c> says; nothing here touches <c>textstack_v2</c> until a V2 route or
    /// <c>/health/ready</c> asks (data-access.md rule 5).
    /// </summary>
    public static IServiceCollection AddTextStackV2Api(this IServiceCollection services) =>
        services
            // An unbindable request throws to ExceptionMiddleware (which answers V2 clients
            // invalid_payload) instead of a bare 400. For every route, as Development already did.
            .Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true)
            .AddSingleton<V2Readiness>()
            // On V2's accounts: IUserRepository itself is bound to legacy until M5.1.
            .AddSingleton(sp => sp.WithV2Users<V2ShadowUsers>())
            // Scoped: it reads the legacy account through the request's IAppDbContext.
            .AddScoped(sp => sp.WithV2Users<V2IdentityMirror>())
            .AddSingleton<LibrarySyncService>()
            .AddSingleton(sp => sp.WithV2Users<LibraryContentService>())
            .AddSingleton<Application.Transitional.ChapterReadService>()
            .AddSingleton<ReadingSyncService>()
            .AddSingleton<AnnotationSyncService>()
            .AddSingleton<VocabularySyncService>()
            .AddSingleton<DiscussionSyncService>();
}
