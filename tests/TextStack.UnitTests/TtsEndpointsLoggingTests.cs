using System.Net.WebSockets;
using Api.Endpoints;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using TextStack.Tts;

namespace TextStack.UnitTests;

// #880: on 2026-10-15 Edge TTS returned 403 for 5+ hours and every /tts call
// became a silent 502. An Error log is what reaches Sentry (MinimumEventLevel = Error).
// Input-driven failures (unknown voice, punctuation-only text → empty audio) must
// not: anonymous callers could spend the Sentry quota.
public class TtsEndpointsLoggingTests
{
    // What the 2026-10-15 outage threw.
    private static WebSocketException Handshake403() =>
        new("The server returned status code '403' when status code '101' was expected.");

    [Fact]
    public async Task Synthesize_EdgeHandshakeRejected_Returns502AndLogsError()
    {
        var upstream = Handshake403();
        var logger = new Mock<ILogger<ITtsService>>();

        var result = await CallSynthesize(upstream, logger.Object);

        Assert.Equal(502, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        VerifyLogged(logger, LogLevel.Error, upstream, Times.Once());
    }

    [Fact]
    public async Task Synthesize_EmptyAudioFromBadInput_Returns502AndLogsWarningNotError()
    {
        var logger = new Mock<ILogger<ITtsService>>();

        var result = await CallSynthesize(new InvalidOperationException("TTS returned empty audio"), logger.Object);

        Assert.Equal(502, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        VerifyLogged(logger, LogLevel.Error, null, Times.Never());
        VerifyLogged(logger, LogLevel.Warning, null, Times.Once());
    }

    [Fact]
    public async Task Synthesize_UpstreamTimesOut_Returns504AndDoesNotLogError()
    {
        var logger = new Mock<ILogger<ITtsService>>();

        var result = await CallSynthesize(new TaskCanceledException(), logger.Object);

        Assert.Equal(504, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        VerifyLogged(logger, LogLevel.Error, null, Times.Never());
        VerifyLogged(logger, LogLevel.Warning, null, Times.Once());
    }

    [Fact]
    public async Task GetTimestamps_EdgeHandshakeRejected_Returns502AndLogsError()
    {
        var upstream = Handshake403();
        var logger = new Mock<ILogger<ITtsService>>();
        var tts = new Mock<ITtsService>();
        tts.Setup(t => t.SynthesizeWithTimestampsAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<double>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(upstream);

        var result = await TtsEndpoints.GetTimestamps(
            new DefaultHttpContext(), "Hello", "en", null, null,
            tts.Object, Options.Create(new TtsConfiguration()), logger.Object, CancellationToken.None);

        Assert.Equal(502, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        VerifyLogged(logger, LogLevel.Error, upstream, Times.Once());
    }

    [Fact]
    public async Task GetVoices_UpstreamFails_Returns502AndLogsError()
    {
        var upstream = new HttpRequestException("Response status code does not indicate success: 403 (Forbidden).");
        var logger = new Mock<ILogger<ITtsService>>();
        var tts = new Mock<ITtsService>();
        tts.Setup(t => t.GetVoicesAsync(It.IsAny<string?>(), It.IsAny<CancellationToken>())).ThrowsAsync(upstream);

        var result = await TtsEndpoints.GetVoices("en", tts.Object, logger.Object, CancellationToken.None);

        Assert.Equal(502, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        VerifyLogged(logger, LogLevel.Error, upstream, Times.Once());
    }

    private static Task<IResult> CallSynthesize(Exception thrown, ILogger<ITtsService> logger)
    {
        var tts = new Mock<ITtsService>();
        tts.Setup(t => t.SynthesizeAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<double>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(thrown);
        return TtsEndpoints.Synthesize(
            new DefaultHttpContext(), "Hello", "en", null, null,
            tts.Object, Options.Create(new TtsConfiguration()), logger, CancellationToken.None);
    }

    private static void VerifyLogged(Mock<ILogger<ITtsService>> logger, LogLevel level, Exception? ex, Times times) =>
        logger.Verify(l => l.Log(
            level,
            It.IsAny<EventId>(),
            It.IsAny<It.IsAnyType>(),
            It.Is<Exception?>(e => ex == null || e == ex),
            It.IsAny<Func<It.IsAnyType, Exception?, string>>()), times);
}
