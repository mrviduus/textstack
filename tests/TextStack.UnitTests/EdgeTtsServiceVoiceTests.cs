using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TextStack.Tts;

namespace TextStack.UnitTests;

// #1334: a lang outside DefaultVoices on a cold server (voice list not loaded yet)
// fell back to en-US-AriaNeural, so a Swahili book was read in an English voice.
public class EdgeTtsServiceVoiceTests
{
    private static readonly List<EdgeVoiceData> Voices =
    [
        new() { ShortName = "en-US-AriaNeural", Locale = "en-US" },
        new() { ShortName = "sw-KE-ZuriNeural", Locale = "sw-KE" },
    ];

    private static EdgeTtsService Service(Func<CancellationToken, Task<List<EdgeVoiceData>>> fetch) =>
        new(Options.Create(new TtsConfiguration()), NullLogger<EdgeTtsService>.Instance, fetch);

    [Fact]
    public async Task ColdList_LangNotInDefaultVoices_LoadsListAndUsesItsVoice()
    {
        var fetches = 0;
        var tts = Service(_ => { fetches++; return Task.FromResult(Voices); });

        Assert.Equal("sw-KE-ZuriNeural", await tts.ResolveDefaultVoiceAsync("sw", CancellationToken.None));
        Assert.Equal("sw-KE-ZuriNeural", await tts.ResolveDefaultVoiceAsync("sw-TZ", CancellationToken.None));
        Assert.Equal(1, fetches);
    }

    [Fact]
    public async Task ColdList_LangWithNoVoice_ThrowsNoVoiceNotEnglish()
    {
        var tts = Service(_ => Task.FromResult(Voices));

        var ex = await Assert.ThrowsAsync<TtsNoVoiceException>(
            () => tts.ResolveDefaultVoiceAsync("xh", CancellationToken.None));
        Assert.Equal("xh", ex.Lang);
    }

    [Fact]
    public async Task ColdList_FetchFails_PropagatesNotEnglish()
    {
        var tts = Service(_ => throw new HttpRequestException("403"));

        await Assert.ThrowsAsync<HttpRequestException>(
            () => tts.ResolveDefaultVoiceAsync("sw", CancellationToken.None));
    }

    [Fact]
    public async Task ColdList_EmptyList_IsAnUpstreamFailureNotNoVoice()
    {
        var tts = Service(_ => Task.FromResult(new List<EdgeVoiceData>()));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => tts.ResolveDefaultVoiceAsync("sw", CancellationToken.None));
    }

    [Fact]
    public async Task LangInDefaultVoices_DoesNotFetchList()
    {
        var tts = Service(_ => throw new InvalidOperationException("must not fetch"));

        Assert.Equal("de-DE-KatjaNeural", await tts.ResolveDefaultVoiceAsync("de-AT", CancellationToken.None));
    }
}
