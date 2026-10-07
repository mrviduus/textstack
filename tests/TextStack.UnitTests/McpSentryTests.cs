using System.Text.Json;
using Microsoft.Extensions.Logging;
using Sentry;
using Sentry.Extensions.Logging;
using Sentry.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;
using TextStack.Observability;

namespace TextStack.UnitTests;

/// <summary>
/// Sentry on the MCP server. The bridge is a public auth surface: every request carries a credential
/// (a bearer, a <c>tsk_</c> connect key, a <c>tso_</c> OAuth token, or the key itself in the
/// <c>/mcp/k/&lt;key&gt;</c> path) and most carry the reader's own text as tool arguments. None of it
/// may reach Sentry; the privacy policy says so. These tests are where that is enforced.
/// </summary>
public class McpSentryTests
{
    // McpKeys.Generate shape: "tsk_" + 43 base64url chars.
    private const string ConnectKey = "tsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
    private const string OAuthToken = "tso_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-zyxwv";
    private const string Jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFkZXIifQ.c2lnbmF0dXJl";
    private const string BookText = "It was the best of times, it was the worst of times";

    // ── RedactSecrets: the free-text rules every host now shares ──────────────────

    [Theory]
    [InlineData("Authorization: Bearer abc.def-ghi rejected", "abc.def-ghi")]
    [InlineData("authorization: bearer " + ConnectKey, ConnectKey)]
    [InlineData("token " + ConnectKey + " is revoked", ConnectKey)]
    [InlineData("refresh failed for " + OAuthToken, OAuthToken)]
    [InlineData("device token " + Jwt + " expired", Jwt)]
    public void RedactSecrets_Credential_IsRemoved(string text, string secret)
    {
        var redacted = SentryScrubber.RedactSecrets(text)!;

        Assert.DoesNotContain(secret, redacted);
        Assert.Contains(SentryScrubber.Redacted, redacted);
    }

    [Theory]
    [InlineData("POST https://textstack.app/mcp/k/" + ConnectKey + " failed")]
    [InlineData("POST /mcp/k/" + ConnectKey + "/ failed")]
    // A malformed key is still a key-shaped secret in the path; the segment goes whatever it holds.
    [InlineData("POST /mcp/k/not-a-real-key-but-still-secret failed")]
    public void RedactSecrets_ConnectUrl_KeySegmentIsRemoved(string text)
    {
        var redacted = SentryScrubber.RedactSecrets(text)!;

        Assert.Contains("/mcp/k/" + SentryScrubber.Redacted, redacted);
        Assert.DoesNotContain(ConnectKey, redacted);
        Assert.DoesNotContain("still-secret", redacted);
    }

    [Theory]
    [InlineData("GET http://api:8080/search?q=what+the+reader+typed failed", "GET http://api:8080/search failed")]
    [InlineData("GET /me/books?search=private&limit=5 404", "GET /me/books 404")]
    public void RedactSecrets_QueryStringInText_IsCut(string text, string expected) =>
        Assert.Equal(expected, SentryScrubber.RedactSecrets(text));

    [Theory]
    [InlineData("Is the upstream down? Retrying in 5s")]
    [InlineData("MCP tool search_books failed with an unexpected error")]
    public void RedactSecrets_OrdinaryText_IsUnchanged(string text) =>
        Assert.Equal(text, SentryScrubber.RedactSecrets(text));

    [Fact]
    public void Scrub_SecretInMessage_IsRedacted()
    {
        var e = new SentryEvent { Message = new SentryMessage { Formatted = "upstream said 401 for Bearer " + OAuthToken } };

        var scrubbed = SentryScrubber.Scrub(e)!;

        Assert.DoesNotContain(OAuthToken, scrubbed.Message!.Formatted);
    }

    [Fact]
    public void ScrubBreadcrumb_ConnectUrl_IsRedacted()
    {
        var crumb = new Breadcrumb("Request starting POST http://textstack.app/mcp/k/" + ConnectKey, "default");

        var scrubbed = SentryScrubber.ScrubBreadcrumb(crumb)!;

        Assert.DoesNotContain(ConnectKey, scrubbed.Message);
    }

    [Fact]
    public void Scrub_RequestUrlQuery_IsStripped()
    {
        var e = new SentryEvent { Request = new SentryRequest { Url = "https://textstack.app/api/tts?text=" + Uri.EscapeDataString(BookText) } };

        var scrubbed = SentryScrubber.Scrub(e)!;

        Assert.Equal("https://textstack.app/api/tts", scrubbed.Request.Url);
    }

    [Fact]
    public void Scrub_HostingScopeRequestPath_IsDropped()
    {
        // ASP.NET's hosting log scope carries RequestPath, and Sentry's logging provider turns scope
        // state into tags — on this host that path is /mcp/k/<key> until the rewrite runs.
        var e = new SentryEvent();
        e.SetTag("RequestPath", "/mcp/k/" + ConnectKey);

        var scrubbed = SentryScrubber.ScrubStrict(e)!;

        Assert.DoesNotContain("RequestPath", scrubbed.Tags.Keys);
    }

    [Fact]
    public void Scrub_ServiceTag_IsKept()
    {
        var e = new SentryEvent();
        e.SetTag(SentryBootstrap.ServiceTag, "mcp-server");

        Assert.Equal("mcp-server", SentryScrubber.Scrub(e)!.Tags[SentryBootstrap.ServiceTag]);
    }

    // ── ScrubStrict: the MCP host's extra rule ────────────────────────────────────

    [Fact]
    public void ScrubStrict_ExceptionMessageWithToolArguments_IsReplacedTypeKept()
    {
        // FormatException quotes the string it failed on; on this host that string is a tool argument.
        var e = new SentryEvent
        {
            SentryExceptions =
            [
                new SentryException { Type = "System.FormatException", Value = $"The input string '{BookText}' was not in a correct format." },
            ],
        };

        var scrubbed = SentryScrubber.ScrubStrict(e)!;

        var ex = Assert.Single(scrubbed.SentryExceptions!);
        Assert.Equal("System.FormatException", ex.Type);
        Assert.Equal(SentryScrubber.Redacted, ex.Value);
    }

    [Fact]
    public void ScrubStrict_StillDropsWhatScrubDrops()
    {
        var e = new SentryEvent(new OperationCanceledException());

        Assert.Null(SentryScrubber.ScrubStrict(e));
    }

    [Fact]
    public void Scrub_NonStrict_KeepsExceptionMessage()
    {
        // The API and Worker keep messages — a constraint name is what makes a DbUpdateException useful.
        var e = new SentryEvent
        {
            SentryExceptions = [new SentryException { Type = "DbUpdateException", Value = "23505: ix_reading_progresses" }],
        };

        Assert.Equal("23505: ix_reading_progresses", Assert.Single(SentryScrubber.Scrub(e)!.SentryExceptions!).Value);
    }

    // ── Wiring ────────────────────────────────────────────────────────────────────

    [Fact]
    public void ConfigureSentry_InformationLines_AreNotBreadcrumbs()
    {
        var options = new SentryLoggingOptions();

        McpHosts.ConfigureSentry(options);

        Assert.Equal(LogLevel.Warning, options.MinimumBreadcrumbLevel);
    }

    [Fact]
    public void Apply_SetsServiceDefaultTag()
    {
        var options = new SentryOptions();

        new SentrySettings("https://k@example.ingest.sentry.io/1", "Production", 0.2, false).Apply(options, "mcp-server");

        Assert.Equal("mcp-server", options.DefaultTags[SentryBootstrap.ServiceTag]);
    }

    // ── The catalog reports its own bugs, without the arguments ───────────────────

    private sealed class ThrowingHandler(Exception ex) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw ex;
    }

    private sealed class CapturingLogger : ILogger<McpToolCatalog>
    {
        public List<(LogLevel Level, string Message, Exception? Exception)> Entries { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception), exception));
    }

    private static (McpToolCatalog Catalog, CapturingLogger Logger) CatalogThatThrows(Exception ex)
    {
        var http = new HttpClient(new ThrowingHandler(ex)) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = "textstack.test", McpToken = "tok" };
        var logger = new CapturingLogger();
        return (new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options)), logger), logger);
    }

    [Fact]
    public async Task CallAsync_UnexpectedException_LogsErrorWithoutArguments()
    {
        var bug = new InvalidOperationException("mapping defect");
        var (catalog, logger) = CatalogThatThrows(bug);

        var result = await catalog.CallAsync(
            "search_books", JsonDocument.Parse($$"""{"query":"{{BookText}}"}""").RootElement, CancellationToken.None);

        Assert.True(result.IsError);
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Same(bug, entry.Exception);
        Assert.Equal("MCP tool search_books failed with an unexpected error", entry.Message);
        Assert.DoesNotContain(BookText, entry.Message);
    }

    [Fact]
    public async Task CallAsync_UpstreamUnavailable_LogsNothing()
    {
        // An API outage is the API's to report (it has its own Sentry and the health checks); the
        // bridge turning each failed call into an event would page the owner N times for one fault.
        var (catalog, logger) = CatalogThatThrows(new HttpRequestException("connection refused"));

        var result = await catalog.CallAsync(
            "search_books", JsonDocument.Parse("""{"query":"dracula"}""").RootElement, CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Empty(logger.Entries);
    }
}
