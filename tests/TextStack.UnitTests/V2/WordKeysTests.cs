using Contracts.V2;

namespace TextStack.UnitTests.V2;

/// <summary>The server's wordKey: legacy's Trim + ToLowerInvariant, pinned where a culture-aware rule would differ.</summary>
public class WordKeysTests
{
    [Theory]
    [InlineData("Quiver", "quiver")]
    [InlineData("  QUIVER\t", "quiver")]
    [InlineData(" Колчан ", "колчан")] // a no-break space is Unicode white space
    [InlineData("Ancien Régime", "ancien régime")]
    public void Of_CasedOrPaddedWord_IsTrimmedAndLowercased(string word, string key)
    {
        Assert.Equal(key, WordKeys.Of(word));
    }

    // Invariant, not Turkish: "I" is "i" (Turkish would give dotless "ı"), and .NET's invariant mapping
    // leaves dotted "İ" as it is, so "İstanbul" and "istanbul" are two keys, exactly as legacy keyed them.
    [Theory]
    [InlineData("ISTANBUL", "istanbul")]
    [InlineData("İSTANBUL", "İstanbul")]
    public void Of_TurkishCapitalI_UsesTheInvariantMapping(string word, string key)
    {
        Assert.Equal(key, WordKeys.Of(word));
    }

    // Lowercasing, not case folding: "ß" stays "ß", so the two spellings stay two cards, as in legacy.
    [Fact]
    public void Of_SharpS_IsNotFoldedToSs()
    {
        Assert.Equal(("straße", "strasse"), (WordKeys.Of("Straße"), WordKeys.Of("STRASSE")));
    }
}
