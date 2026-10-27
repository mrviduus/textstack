using Application.Vocabulary;

namespace TextStack.UnitTests;

/// <summary>
/// FrequencyFilter reads the embedded wordfreq file (#935). The ranks and Zipf scores below are the
/// file's — the same values the word_frequencies table held, since it was a copy of that file.
/// </summary>
public class FrequencyFilterTests
{
    [Theory]
    [InlineData("you", 1, 7.6, FrequencyClassKind.SrsEligible)]
    [InlineData("The", 3, 7.5, FrequencyClassKind.SrsEligible)]
    [InlineData("campus", 5000, 3.98, FrequencyClassKind.SrsEligible)]
    [InlineData("ritual", 5001, 3.98, FrequencyClassKind.RequiresRetap)]
    [InlineData("restrictions", 15000, 3.26, FrequencyClassKind.RequiresRetap)]
    [InlineData("implied", 15001, 3.26, FrequencyClassKind.LookupOnly)]
    [InlineData("eradicate", 20000, 3.05, FrequencyClassKind.LookupOnly)]
    public void Classify_KnownWord_UsesFileRankAndZipf(string word, int rank, double zipf, FrequencyClassKind kind)
    {
        var c = FrequencyFilter.Classify(word, "en", currentTapCount: 0);

        Assert.Equal(kind, c.Kind);
        Assert.Equal(rank, c.ZipfRank);
        Assert.Equal(zipf, c.ZipfScore);
    }

    [Fact]
    public void Classify_MidTierSecondTap_IsSrsEligible() =>
        Assert.Equal(FrequencyClassKind.SrsEligible, FrequencyFilter.Classify("ritual", "en", currentTapCount: 1).Kind);

    [Fact]
    public void Classify_UnknownWord_IsLookupOnlyWithoutRank()
    {
        var c = FrequencyFilter.Classify("zzqxv", "en", currentTapCount: 0);

        Assert.Equal(FrequencyClassKind.LookupOnly, c.Kind);
        Assert.Null(c.ZipfRank);
    }

    [Fact]
    public void Classify_OtherLanguage_FailsOpenToSrs() =>
        Assert.Equal(FrequencyClassKind.SrsEligible, FrequencyFilter.Classify("zzqxv", "de", currentTapCount: 0).Kind);
}
