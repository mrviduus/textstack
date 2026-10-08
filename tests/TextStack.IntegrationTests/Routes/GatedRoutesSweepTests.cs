using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using TextStack.Tests.Routes;

namespace TextStack.IntegrationTests.Routes;

/// <summary>
/// ADR-024: every <c>/me</c> route called with no credential answers 401, and every <c>/internal</c>
/// route called from outside the docker network answers 403. The route list comes
/// from the Api's own endpoint table (<see cref="ApiRouteTable"/>), so a route added tomorrow is
/// swept tomorrow without anyone editing this file.
///
/// <para>Against the running stack (<c>API_URL</c>, default localhost:8080). The route table is the
/// code under test; a stack older than it answers 404 for the newer routes, which fails here on
/// purpose — run it against the build you are checking.</para>
/// </summary>
public class GatedRoutesSweepTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public GatedRoutesSweepTests(LiveApiFixture fixture) => _fixture = fixture;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // {name}, {name:constraint}, {name?}, {name=default}, {*name}, {**name}
    private static readonly Regex Param = new(@"\{\*{0,2}([^}:=?]+)(:[^}=?]+)?\??(=[^}]*)?\}", RegexOptions.Compiled);

    /// <summary>A value each parameter binds to, so a 400 from binding is never mistaken for an answer.</summary>
    internal static string Fill(string pattern) => Param.Replace(pattern, m =>
    {
        var name = m.Groups[1].Value;
        var constraint = m.Groups[2].Value;
        if (constraint.Contains("int") || constraint.Contains("long")) return "1";
        if (constraint.Contains("guid") || name.EndsWith("id", StringComparison.OrdinalIgnoreCase))
            return Guid.NewGuid().ToString();
        return "x";
    });

    [Fact]
    public void RouteTable_GatedRoutes_AreFound()
    {
        // Guards the sweeps against sweeping nothing: an empty table would pass them vacuously.
        Assert.True(ApiRouteTable.Routes.Count(r => r.Under("/me")) > 50);
        Assert.True(ApiRouteTable.Routes.Count(r => r.Under("/internal")) >= 20);
    }

    [Fact]
    public async Task EveryMeRoute_Anonymous_Returns401()
    {
        var failures = await SweepAsync("/me", HttpStatusCode.Unauthorized, _ => { });
        Assert.True(failures.Count == 0, "Answered anonymously without 401:\n" + string.Join("\n", failures));
    }

    /// <summary>
    /// "Outside" the way production sees it: through the proxy chain, which ForwardedHeaders turns
    /// into the client's own address. A direct call from the test host would not do: Docker
    /// publishes ports from a bridge address, which is on the allow-list by design.
    /// </summary>
    [Fact]
    public async Task EveryInternalRoute_FromOutside_Returns403()
    {
        var failures = await SweepAsync("/internal", HttpStatusCode.Forbidden,
            req => req.Headers.Add("X-Forwarded-For", "203.0.113.7"));
        Assert.True(failures.Count == 0, "Answered an outside caller without 403:\n" + string.Join("\n", failures));
    }

    private async Task<List<string>> SweepAsync(string prefix, HttpStatusCode expected, Action<HttpRequestMessage> configure)
    {
        var failures = new List<string>();
        foreach (var route in ApiRouteTable.Routes.Where(r => r.Under(prefix)))
        {
            var req = _fixture.CreateRequest(new HttpMethod(route.Method), Fill(route.Pattern));
            if (route.Method is "POST" or "PUT" or "PATCH")
                req.Content = new StringContent("{}", Encoding.UTF8, "application/json");
            configure(req);

            using var resp = await _fixture.Client.SendAsync(req, Ct);
            if (resp.StatusCode != expected)
                failures.Add($"{route} -> {(int)resp.StatusCode}");
        }
        return failures;
    }

    /// <summary>The spellings the admin gate was probed with. None may reach a handler as anonymous.</summary>
    [Theory]
    [InlineData("/ME/library")]
    [InlineData("/Me/Library")]
    [InlineData("//me/library")]
    [InlineData("/./me/library")]
    [InlineData("/x/../me/library")]
    [InlineData("/me/./library")]
    [InlineData("/%6De/library")]
    [InlineData("/me%2flibrary")]
    [InlineData("/me%2Flibrary")]
    public async Task MeLibrary_PathSpellings_Anonymous_NeverSucceed(string path)
    {
        var req = _fixture.CreateRequest(HttpMethod.Get, "/");
        // Canonicalisation off, so the server sees the raw spelling rather than what Uri makes of it.
        req.RequestUri = new Uri(_fixture.Client.BaseAddress!.GetLeftPart(UriPartial.Authority) + path, new UriCreationOptions { DangerousDisablePathAndQueryCanonicalization = true });

        using var resp = await _fixture.Client.SendAsync(req, Ct);

        Assert.False(resp.IsSuccessStatusCode, $"{path} -> {(int)resp.StatusCode}");
        Assert.Contains(resp.StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.NotFound, HttpStatusCode.BadRequest });
    }
}
