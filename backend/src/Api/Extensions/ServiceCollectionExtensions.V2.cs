using Api.V2;
using Application.Annotations;
using Application.Identity;
using Application.Library;
using Application.Reading;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// The /me/v2 use cases, their readiness gate and the shadow-user bridge. Registered whatever
    /// <c>Features:V2Api</c> says; nothing here touches <c>textstack_v2</c> until a V2 route or
    /// <c>/health/ready</c> asks (data-access.md rule 5).
    /// </summary>
    public static IServiceCollection AddTextStackV2Api(this IServiceCollection services) =>
        services
            .AddSingleton<V2Readiness>()
            .AddSingleton<V2ShadowUsers>()
            .AddSingleton<LibrarySyncService>()
            .AddSingleton<ReadingSyncService>()
            .AddSingleton<AnnotationSyncService>();
}
