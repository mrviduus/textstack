using Api.Endpoints;
using Domain.Entities;

namespace TextStack.UnitTests;

/// <summary>TR-2: an automatic fill (onlyIfEmpty) never changes a saved translation; a plain PATCH replaces.</summary>
public class VocabularyUpdateOnlyIfEmptyTests
{
    [Theory]
    [Trait("Rule", "TR-2")]
    [InlineData("сад", true, "сад")]   // saved + automatic fill → unchanged
    [InlineData(null, true, "дім")]    // empty + automatic fill → written
    [InlineData("  ", true, "дім")]    // blank counts as empty
    [InlineData("сад", false, "дім")]  // no flag (TR-3 button) → replaced
    public void ApplyUpdate_OnlyIfEmpty_WritesOnlyEmptyTranslation(string? stored, bool onlyIfEmpty, string expected)
    {
        var word = new VocabularyWord { Word = "house", Language = "en", Translation = stored };

        VocabularyEndpoints.ApplyUpdate(word, new UpdateWordRequest("дім", null, onlyIfEmpty));

        Assert.Equal(expected, word.Translation);
    }
}
