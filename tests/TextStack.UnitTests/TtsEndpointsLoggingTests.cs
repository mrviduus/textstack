using System.Net.WebSockets;
using Api.Endpoints;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using TextStack.Tts;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

// #880: on 2026-10-15 Edge TTS returned 403 for 5+ hours and every /tts call
// became a silent 502. An Error log is what reaches Sentry (MinimumEventLevel = Error).
// Input-driven failures (unknown voice, punctuation-only text → empty audio) must
// not: anonymous callers could spend the Sentry quota.
public class TtsEndpointsLoggingTests
{
    private static Exception Upstream(string cause) => cause switch
    {
        // What the 2026-10-15 outage threw.
        "handshake 403" => new WebSocketException("The server returned status code '403' when status code '101' was expected."),
        "voices 403" => new HttpRequestException("Response status code does not indicate success: 403 (Forbidden)."),
        "empty audio" => new InvalidOperationException("TTS returned empty audio"),
        "timeout" => new TaskCanceledException(),
        // #1334: no voice for the lang is the reader's book, not an outage.
        "no voice" => new TtsNoVoiceException("xh"),
        _ => throw new ArgumentOutOfRangeException(nameof(cause)),
    };

    [Theory]
    [InlineData("synthesize", "handshake 403", 502, LogLevel.Error)]
    [InlineData("synthesize", "empty audio", 502, LogLevel.Warning)]
    [InlineData("synthesize", "timeout", 504, LogLevel.Warning)]
    [InlineData("synthesize", "no voice", 422, LogLevel.Warning)]
    [InlineData("timestamps", "handshake 403", 502, LogLevel.Error)]
    [InlineData("voices", "voices 403", 502, LogLevel.Error)]
    public async Task TtsEndpoint_UpstreamFails_LoggedAtTheLevelItsCauseDeserves(string endpoint, string cause, int status, LogLevel level)
    {
        var upstream = Upstream(cause);
        var logger = new CapturingLogger<ITtsService>();
        var tts = Substitute.For<ITtsService>();
        tts.SynthesizeAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<double>(), Arg.Any<CancellationToken>()).ThrowsAsync(upstream);
        tts.SynthesizeWithTimestampsAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<double>(), Arg.Any<CancellationToken>()).ThrowsAsync(upstream);
        tts.GetVoicesAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>()).ThrowsAsync(upstream);
        var config = Options.Create(new TtsConfiguration());

        var result = endpoint switch
        {
            "synthesize" => await TtsEndpoints.Synthesize(new DefaultHttpContext(), "Hello", "en", null, null, tts, config, logger, CancellationToken.None),
            "timestamps" => await TtsEndpoints.GetTimestamps(new DefaultHttpContext(), "Hello", "en", null, null, tts, config, logger, CancellationToken.None),
            "voices" => await TtsEndpoints.GetVoices("en", tts, logger, CancellationToken.None),
            _ => throw new ArgumentOutOfRangeException(nameof(endpoint)),
        };

        Assert.Equal(status, Assert.IsType<ProblemHttpResult>(result).StatusCode);
        // Each endpoint reaches its own upstream call, and only that one.
        await tts.Received(endpoint == "synthesize" ? 1 : 0).SynthesizeAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<double>(), Arg.Any<CancellationToken>());
        await tts.Received(endpoint == "timestamps" ? 1 : 0).SynthesizeWithTimestampsAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<double>(), Arg.Any<CancellationToken>());
        await tts.Received(endpoint == "voices" ? 1 : 0).GetVoicesAsync(Arg.Any<string?>(), Arg.Any<CancellationToken>());
        // One entry, at the cause's level: Error reaches Sentry; input-driven Warnings stay out of it.
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(level, entry.Level);
        if (level == LogLevel.Error)
            Assert.Same(upstream, entry.Exception); // the outage reaches Sentry with its cause
    }
}
