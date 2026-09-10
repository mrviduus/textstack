using Application.Auth;

namespace TextStack.UnitTests;

/// <summary>
/// The connect key's shape and recogniser. These are the parts a database cannot check for us: that
/// a key is distinguishable from a JWT before any lookup happens, that two keys are never the same,
/// and that the clear-text prefix stays a prefix.
/// </summary>
public class McpKeysTests
{
    [Fact]
    public void Generate_Always_StartsWithThePrefix()
    {
        Assert.StartsWith(McpKeys.Prefix, McpKeys.Generate(), StringComparison.Ordinal);
    }

    [Fact]
    public void Generate_Always_IsUrlSafe()
    {
        // The key is copied by hand into JSON config and sometimes into URLs. '+', '/' and '=' do
        // not survive that reliably, which is why this is base64url and not DeviceCodes' base64.
        var key = McpKeys.Generate();
        Assert.DoesNotContain('+', key);
        Assert.DoesNotContain('/', key);
        Assert.DoesNotContain('=', key);
    }

    [Fact]
    public void Generate_ManyTimes_NeverRepeats()
    {
        var keys = Enumerable.Range(0, 500).Select(_ => McpKeys.Generate()).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(500, keys.Count);
    }

    [Fact]
    public void LooksLikeKey_AJwt_IsFalse()
    {
        // The whole "ordinary traffic pays only a prefix check" claim rests on this: a real access
        // token must never be routed into the key lookup.
        const string jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
        Assert.False(McpKeys.LooksLikeKey(jwt));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("TSK_upper")]   // prefix match is Ordinal, not case-insensitive
    [InlineData("xtsk_notatstart")]
    public void LooksLikeKey_NotAKey_IsFalse(string? token)
    {
        Assert.False(McpKeys.LooksLikeKey(token));
    }

    [Fact]
    public void LooksLikeKey_AGeneratedKey_IsTrue()
    {
        Assert.True(McpKeys.LooksLikeKey(McpKeys.Generate()));
    }

    [Fact]
    public void DisplayPrefix_AGeneratedKey_IsAPrefixAndFarShorterThanTheKey()
    {
        var key = McpKeys.Generate();
        var prefix = McpKeys.DisplayPrefix(key);

        Assert.StartsWith(prefix, key, StringComparison.Ordinal);
        Assert.Equal(McpKeys.DisplayPrefixLength, prefix.Length);
        Assert.True(prefix.Length < key.Length / 3, "the stored clear-text head must not approach the secret");
    }

    [Theory]
    [InlineData("")]
    [InlineData("ab")]
    public void DisplayPrefix_ShorterThanTheWindow_DoesNotThrow(string raw)
    {
        Assert.Equal(raw, McpKeys.DisplayPrefix(raw));
    }

    [Fact]
    public void NormalizeName_Blank_FallsBackToAReadableDefault()
    {
        // A list of keys called "" is a list nobody can revoke from with confidence.
        Assert.Equal("Assistant", McpKeys.NormalizeName(null));
        Assert.Equal("Assistant", McpKeys.NormalizeName("   "));
    }

    [Fact]
    public void NormalizeName_TooLong_IsCappedToTheColumn()
    {
        var name = McpKeys.NormalizeName(new string('x', 500));
        Assert.Equal(McpKeys.MaxNameLength, name.Length);
    }

    [Fact]
    public void NormalizeName_Padded_IsTrimmed()
    {
        Assert.Equal("Claude Desktop", McpKeys.NormalizeName("  Claude Desktop  "));
    }

    [Fact]
    public void HashToken_TheSameKey_IsStable_AndDiffersPerKey()
    {
        // Storage reuses DeviceCodes.HashToken rather than growing a second hash helper; this pins
        // that it behaves as the lookup needs.
        var a = McpKeys.Generate();
        var b = McpKeys.Generate();

        Assert.Equal(DeviceCodes.HashToken(a), DeviceCodes.HashToken(a));
        Assert.NotEqual(DeviceCodes.HashToken(a), DeviceCodes.HashToken(b));
        Assert.DoesNotContain(a, DeviceCodes.HashToken(a), StringComparison.Ordinal);
    }
}
