using System.Text.Json;
using Api.Middleware;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests;

public class WriteFreezeTests
{
    [Theory]
    [InlineData("POST", "/auth/register")]
    [InlineData("PUT", "/me/v2/reading/sessions/test")]
    [InlineData("PATCH", "/me/v2/books/test")]
    [InlineData("DELETE", "/me/account")]
    [InlineData("POST", "/oauth/token")]
    [InlineData("POST", "/admin/books")]
    [InlineData("POST", "/internal/jobs")]
    [InlineData("TRACE", "/")]
    [InlineData("CUSTOM", "/")]
    [InlineData("GET", "/oauth/authorize")]
    [InlineData("HEAD", "/OAUTH/AUTHORIZE/")]
    public async Task Frozen_Mutation_ReturnsRetryable503WithoutReachingHandler(string method, string path)
    {
        var reached = false;
        await using var server = await Server(true, _ => { reached = true; return Task.CompletedTask; });

        using var response = await server.GetTestClient().SendAsync(new HttpRequestMessage(new HttpMethod(method), path), TestContext.Current.CancellationToken);

        Assert.Equal(503, (int)response.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(60), response.Headers.RetryAfter?.Delta);
        Assert.True(response.Headers.CacheControl?.NoStore);
        if (method != "HEAD")
        {
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
            if (path.StartsWith("/me/v2", StringComparison.Ordinal))
            {
                Assert.Equal("v2_unavailable", body.RootElement.GetProperty("code").GetString());
                Assert.False(string.IsNullOrWhiteSpace(body.RootElement.GetProperty("message").GetString()));
            }
            else
                Assert.Equal("write_frozen", body.RootElement.GetProperty("error").GetString());
        }
        Assert.False(reached);
    }

    [Theory]
    [InlineData("GET", "/me/library")]
    [InlineData("GET", "/health/ready")]
    [InlineData("GET", "/auth/me")]
    [InlineData("GET", "/.well-known/oauth-authorization-server")]
    [InlineData("GET", "/oauth/requests/test")]
    [InlineData("HEAD", "/storage/cover.jpg")]
    [InlineData("OPTIONS", "/oauth/authorize")]
    [InlineData("OPTIONS", "/me/v2/books/test")]
    public async Task Frozen_ReadOrPreflight_ReachesHandler(string method, string path)
    {
        await using var server = await Server(true, http => { http.Response.StatusCode = 204; return Task.CompletedTask; });

        using var response = await server.GetTestClient().SendAsync(new HttpRequestMessage(new HttpMethod(method), path), TestContext.Current.CancellationToken);

        Assert.Equal(204, (int)response.StatusCode);
        Assert.Null(response.Headers.RetryAfter);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(false)]
    public async Task DisabledOrUnset_Mutation_ReachesHandler(bool? enabled)
    {
        await using var server = await Server(enabled, http => { http.Response.StatusCode = 204; return Task.CompletedTask; });
        using var response = await server.GetTestClient().PostAsync("/auth/register", null, TestContext.Current.CancellationToken);
        Assert.Equal(204, (int)response.StatusCode);
    }

    private static async Task<WebApplication> Server(bool? enabled, RequestDelegate handler)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [WriteFreezeMiddleware.ConfigurationKey] = enabled?.ToString(),
        });
        var app = builder.Build();
        app.UseMiddleware<WriteFreezeMiddleware>();
        app.Run(handler);
        await app.StartAsync(TestContext.Current.CancellationToken);
        return app;
    }
}
