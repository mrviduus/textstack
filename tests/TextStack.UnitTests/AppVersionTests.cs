using System.Diagnostics;
using Api.Endpoints;
using Api.Middleware;
using Infrastructure.Telemetry;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Sentry;

namespace TextStack.UnitTests;

/// <summary>Review item #23: the server sees which mobile build calls, and serves the minimum.</summary>
public class AppVersionTests
{
    private static HttpContext Request(params (string Header, string Value)[] headers)
    {
        var ctx = new DefaultHttpContext();
        foreach (var (h, v) in headers) ctx.Request.Headers[h] = v;
        return ctx;
    }

    [Theory]
    [InlineData("1.2.10")]
    [InlineData("1.0.0-beta.1")]
    [InlineData("24")]
    public void Read_VersionShaped_ReturnsValue(string value) =>
        Assert.Equal(value, AppVersionMiddleware.Read(Request(("X-App-Version", value)).Request, "X-App-Version"));

    [Theory]
    [InlineData("")]
    [InlineData("1.0.0\nINJECTED log line")]
    [InlineData("<script>")]
    [InlineData("1.0.0 (24)")]
    [InlineData("123456789012345678901234567890123")] // 33 chars
    public void Read_MissingOrHostile_ReturnsNull(string value) =>
        Assert.Null(AppVersionMiddleware.Read(Request(("X-App-Version", value)).Request, "X-App-Version"));

    [Fact]
    public async Task InvokeAsync_HeadersPresent_TagsSpanAndOpensLogScope()
    {
        var logger = new ScopeCapturingLogger();
        var ctx = Request(("X-App-Version", "1.2.3"), ("X-App-Build", "42"));
        IReadOnlyDictionary<string, object?>? scopeSeenByNext = null;
        var middleware = new AppVersionMiddleware(_ =>
        {
            scopeSeenByNext = logger.Current;
            return Task.CompletedTask;
        }, logger);

        using var activity = new Activity("request").Start();
        await middleware.InvokeAsync(ctx);

        Assert.Equal("1.2.3", activity.GetTagItem("app.version"));
        Assert.Equal("42", activity.GetTagItem("app.build"));
        Assert.NotNull(scopeSeenByNext);
        Assert.Equal("1.2.3", scopeSeenByNext!["AppVersion"]);
        Assert.Equal("42", scopeSeenByNext["AppBuild"]);
        Assert.Null(logger.Current); // scope closed after the request
    }

    [Fact]
    public async Task InvokeAsync_NoHeaders_NoScopeNoTag()
    {
        var logger = new ScopeCapturingLogger();
        var called = false;
        var middleware = new AppVersionMiddleware(_ => { called = true; return Task.CompletedTask; }, logger);

        using var activity = new Activity("request").Start();
        await middleware.InvokeAsync(Request());

        Assert.True(called);
        Assert.Null(activity.GetTagItem("app.version"));
        Assert.Equal(0, logger.ScopesOpened);
    }

    [Fact]
    public void Scrub_AppVersionTags_SurviveAllowlist()
    {
        var e = new SentryEvent();
        e.SetTag("app.version", "1.2.3");
        e.SetTag("app.build", "42");

        var scrubbed = SentryScrubber.Scrub(e)!;

        Assert.Equal("1.2.3", scrubbed.Tags["app.version"]);
        Assert.Equal("42", scrubbed.Tags["app.build"]);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("  ", null)]
    [InlineData(" 1.1.0 ", "1.1.0")]
    public void GetAppConfig_MinSupportedVersion_ReturnsTrimmedOrNull(string? configured, string? expected)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Mobile:MinSupportedVersion"] = configured })
            .Build();

        var result = Assert.IsType<Ok<AppConfigResponse>>(AppConfigEndpoints.GetAppConfig(config));

        Assert.Equal(expected, result.Value!.MinSupportedVersion);
    }

    private sealed class ScopeCapturingLogger : ILogger<AppVersionMiddleware>
    {
        public IReadOnlyDictionary<string, object?>? Current { get; private set; }
        public int ScopesOpened { get; private set; }

        public IDisposable BeginScope<TState>(TState state) where TState : notnull
        {
            ScopesOpened++;
            Current = (IReadOnlyDictionary<string, object?>)state;
            return new Closer(() => Current = null);
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        { }

        private sealed class Closer(Action close) : IDisposable
        {
            public void Dispose() => close();
        }
    }
}
