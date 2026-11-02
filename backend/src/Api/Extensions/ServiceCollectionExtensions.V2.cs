using Api.V2;
using Application.Annotations;
using Application.Discussion;
using Application.Identity;
using Application.Library;
using Application.Reading;
using Application.Vocabulary;
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
            .AddSingleton<V2ShadowUsers>()
            // Scoped: it reads the legacy account through the request's IAppDbContext.
            .AddScoped<V2IdentityMirror>()
            .AddSingleton<LibrarySyncService>()
            .AddSingleton<ReadingSyncService>()
            .AddSingleton<AnnotationSyncService>()
            .AddSingleton<VocabularySyncService>()
            .AddSingleton<DiscussionSyncService>();
}
