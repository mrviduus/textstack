using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using TextStack.Tests.Routes;

namespace TextStack.IntegrationTests.Routes;

/// <summary>
/// ADR-024 PR 0: every <c>/me</c> route, called with no credential, answers 401. The route list comes
/// from the Api's own endpoint table (<see cref="ApiRouteTable"/>), so a route added tomorrow is
/// swept tomorrow without anyone editing this file.
///
/// <para>Against the running stack (<c>API_URL</c>, default localhost:8080). The route table is the
/// code under test; a stack older than it answers 404 for the newer routes, which fails here on
/// purpose — run it against the build you are checking.</para>
/// </summary>
public class MeAnonymousSweepTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public MeAnonymousSweepTests(LiveApiFixture fixture) => _fixture = fixture;

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
    public void RouteTable_MeRoutes_AreFound()
    {
        // Guards the sweep against sweeping nothing: an empty table would pass it vacuously.
        Assert.True(ApiRouteTable.Routes.Count(r => r.Under("/me")) > 50);
    }

    [Fact]
    public async Task EveryMeRoute_Anonymous_Returns401()
    {
        var failures = new List<string>();
        foreach (var route in ApiRouteTable.Routes.Where(r => r.Under("/me")))
        {
            var req = _fixture.CreateRequest(new HttpMethod(route.Method), Fill(route.Pattern));
            if (route.Method is "POST" or "PUT" or "PATCH")
                req.Content = new StringContent("{}", Encoding.UTF8, "application/json");

            using var resp = await _fixture.Client.SendAsync(req, Ct);
            if (resp.StatusCode != HttpStatusCode.Unauthorized)
                failures.Add($"{route} -> {(int)resp.StatusCode}");
        }

        Assert.True(failures.Count == 0, "Answered anonymously without 401:\n" + string.Join("\n", failures));
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
