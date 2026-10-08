using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace TextStack.Tests.Routes;

/// <summary>
/// Every route the Api maps, read from its own <see cref="EndpointDataSource"/> — not a hand list.
/// Booted in-process as environment <c>Test</c> (no migrations, no config validation, and nothing
/// here resolves a DbContext, so no database is needed) with <c>ENABLE_TEST_AUTH=true</c> so the
/// test-login route is listed too, and every hosted service removed. Shared by the anonymous
/// <c>/me</c> sweep (IntegrationTests) and the public-routes snapshot (UnitTests): linked, not copied
/// (ADR-024).
/// </summary>
internal static class ApiRouteTable
{
    public sealed record Route(string Method, string Pattern)
    {
        public override string ToString() => $"{Method} {Pattern}";

        /// <summary>Under <paramref name="prefix"/> by whole segment, case-insensitive — as the gates match.</summary>
        public bool Under(string prefix) =>
            Pattern.Equals(prefix, StringComparison.OrdinalIgnoreCase)
            || Pattern.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);
    }

    private static readonly Lazy<IReadOnlyList<Route>> All = new(Load);

    public static IReadOnlyList<Route> Routes => All.Value;

    private static IReadOnlyList<Route> Load()
    {
        using var factory = new WebApplicationFactory<Api.ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("ENABLE_TEST_AUTH", "true");
            // Storage is created at registration; the default /storage is read-only off a container.
            b.UseSetting("Storage:RootPath", Path.Combine(Path.GetTempPath(), "textstack-route-table"));
            b.ConfigureTestServices(s => s.RemoveAll<IHostedService>());
        });

        return factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .SelectMany(e => (e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? ["ANY"])
                .Select(m => new Route(m, "/" + e.RoutePattern.RawText!.TrimStart('/'))))
            .Distinct()
            .OrderBy(r => r.Pattern, StringComparer.Ordinal)
            .ThenBy(r => r.Method, StringComparer.Ordinal)
            .ToList();
    }
}
