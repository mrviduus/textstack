using TextStack.Tests.Routes;

namespace TextStack.UnitTests.Routes;

/// <summary>
/// ADR-024 §2: every route that no path gate covers, as <c>METHOD /pattern</c>, must equal the
/// checked-in <c>routes.public.txt</c>. Gated means <c>/me</c>, <c>/internal</c>, and <c>/admin</c>
/// except <c>/admin/auth</c> (the admin gate skips it, so its routes are public and listed).
///
/// <para>A new public route — or a user route someone put outside <c>/me</c> — fails here until the
/// file is updated in the same PR, so a reviewer reads it. To update: copy the "actual" block from
/// the failure message into <c>tests/TextStack.UnitTests/Routes/routes.public.txt</c>.</para>
/// </summary>
public class PublicRoutesSnapshotTests
{
    private static bool Gated(ApiRouteTable.Route r) =>
        r.Under("/me") || r.Under("/internal") || (r.Under("/admin") && !r.Under("/admin/auth"));

    [Fact]
    public void PublicRoutes_MatchCheckedInSnapshot()
    {
        var actual = ApiRouteTable.Routes.Where(r => !Gated(r)).Select(r => r.ToString()).ToList();
        var expected = File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Routes", "routes.public.txt"))
            .Where(l => l.Length > 0 && !l.StartsWith('#'))
            .ToList();

        var added = actual.Except(expected).ToList();
        var removed = expected.Except(actual).ToList();

        Assert.True(added.Count == 0 && removed.Count == 0,
            "Public routes changed. Review, then update tests/TextStack.UnitTests/Routes/routes.public.txt.\n"
            + $"New (public, ungated): {string.Join(", ", added)}\n"
            + $"Gone: {string.Join(", ", removed)}\n"
            + "--- actual ---\n" + string.Join("\n", actual));
    }

    [Fact]
    public void RouteTable_IncludesTestLoginAndGatedRoutes()
    {
        // Guards the snapshot against comparing an empty or partial table: the flag reached the app,
        // and the gated prefixes are really there to be excluded.
        var routes = ApiRouteTable.Routes;
        Assert.Contains(routes, r => r.ToString() == "POST /auth/test-login");
        Assert.Contains(routes, r => r.Under("/me"));
        Assert.Contains(routes, r => r.Under("/internal"));
        Assert.Contains(routes, r => r.Under("/admin") && !r.Under("/admin/auth"));
    }
}
