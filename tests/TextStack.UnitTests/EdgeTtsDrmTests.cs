using TextStack.Tts;

namespace TextStack.UnitTests;

/// <summary>
/// #827: Edge TTS answers 403 to the v1 Sec-MS-GEC token. Expected values were
/// produced by upstream rany2/edge-tts drm.py <c>generate_sec_ms_gec_v2(ts)</c>.
/// </summary>
public class EdgeTtsDrmTests
{
    [Theory]
    [InlineData(0L, "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6")]
    [InlineData(1_700_000_000L, "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2")]
    [InlineData(1_760_531_100L, "2BF22EFD29D30A23-98441303577D5902935C4ED67700ABD4D4F926B080559811F6B816B8FD3D533D")]
    [InlineData(2_000_000_000L, "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E")]
    public void GenerateSecMsGec_FixedTimestamp_MatchesUpstream(long unixSeconds, string expected)
    {
        Assert.Equal(expected, EdgeTtsDrm.GenerateSecMsGec(unixSeconds));
    }

    [Fact]
    public void GenerateSecMsGec_SameFiveMinuteWindow_SameToken()
    {
        // upstream: 1760531234.75 and 1760531100 give the same token; 1760531099.999 the previous window's.
        Assert.Equal(EdgeTtsDrm.GenerateSecMsGec(1_760_531_100L), EdgeTtsDrm.GenerateSecMsGec(1_760_531_234L));
        Assert.Equal(
            "618DCF0E6EE9DF75-66CC919D46CD70D97A7BDE0165DD17BF46F41D5BC5A17DF6C033CC3C0C2637F3",
            EdgeTtsDrm.GenerateSecMsGec(1_760_531_099L));
    }

    [Fact]
    public void SecMsGecVersion_IsV2()
    {
        Assert.Equal("2-143.0.3650.75", EdgeTtsDrm.SecMsGecVersion);
    }

    [Fact]
    public void SkewFromServerDate_ServerAhead_ReturnsPositiveSeconds()
    {
        var client = new DateTimeOffset(2025, 10, 15, 11, 59, 0, TimeSpan.Zero);
        Assert.Equal(60.0, EdgeTtsDrm.SkewFromServerDate("Wed, 15 Oct 2025 12:00:00 GMT", client));
    }

    [Fact]
    public void SkewFromServerDate_ClientOneHourBehind_Returns3600()
    {
        var client = new DateTimeOffset(2025, 10, 15, 11, 0, 0, TimeSpan.Zero);
        Assert.Equal(3600.0, EdgeTtsDrm.SkewFromServerDate("Wed, 15 Oct 2025 12:00:00 GMT", client));
    }

    [Theory]
    [InlineData(13)]
    [InlineData(-13)]
    public void SkewFromServerDate_MoreThan12Hours_ReturnsNull(int hours)
    {
        var client = new DateTimeOffset(2025, 10, 15, 12, 0, 0, TimeSpan.Zero).AddHours(-hours);
        Assert.Null(EdgeTtsDrm.SkewFromServerDate("Wed, 15 Oct 2025 12:00:00 GMT", client));
    }

    [Theory]
    [InlineData(1_760_531_150.0, 0.5, false)]   // mid-window, sub-second: same token, retry is pointless
    [InlineData(1_760_531_150.0, -40.0, false)] // still inside the same 5-min window
    [InlineData(1_760_531_099.5, 0.8, true)]    // crosses the window edge: new token
    [InlineData(1_760_531_150.0, 3600.0, true)] // the forced 1 h skew of the live check
    public void TokenChanges_Skew_TrueOnlyWhenWindowMoves(double clientUnixNow, double skew, bool expected)
    {
        Assert.Equal(expected, EdgeTtsDrm.TokenChanges(clientUnixNow, skew));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a date")]
    public void SkewFromServerDate_MissingOrBadDate_ReturnsNull(string? date)
    {
        Assert.Null(EdgeTtsDrm.SkewFromServerDate(date, DateTimeOffset.UtcNow));
    }
}
