using Application.Identity;

namespace TextStack.UnitTests;

/// <summary>
/// Pure-logic tests for the device-grant (RFC 8628, AI-050a) helpers:
/// user_code shape/alphabet, normalization, and SHA256 hashing.
/// </summary>
public class DeviceCodesTests
{
    [Fact]
    public void GenerateUserCode_HasGroupedShape_XXXXdashXXXX()
    {
        var code = DeviceCodes.GenerateUserCode();

        Assert.Equal(9, code.Length);
        Assert.Equal('-', code[4]);
        Assert.Matches("^[A-Z2-9]{4}-[A-Z2-9]{4}$", code);
    }

    [Fact]
    public void GenerateUserCode_UsesUnambiguousAlphabetOnly_NoIO01()
    {
        // 200 samples: never emit an ambiguous char.
        for (var i = 0; i < 200; i++)
        {
            var code = DeviceCodes.GenerateUserCode().Replace("-", "");
            foreach (var c in code)
            {
                Assert.DoesNotContain(c, "IO01");
                Assert.Contains(c, DeviceCodes.UserCodeAlphabet);
            }
        }
    }

    [Fact]
    public void GenerateUserCode_ProducesVariedValues_NotConstant()
    {
        var set = new HashSet<string>();
        for (var i = 0; i < 50; i++)
            set.Add(DeviceCodes.GenerateUserCode());

        Assert.True(set.Count > 40, "user_code should be high-entropy across samples");
    }

    [Theory]
    [InlineData("wdjb-mqxr", "WDJB-MQXR")]
    [InlineData("WDJBMQXR", "WDJB-MQXR")]
    [InlineData(" wdjb mqxr ", "WDJB-MQXR")]
    [InlineData("wdjb-MQXR", "WDJB-MQXR")]
    public void NormalizeUserCode_UppercasesAndRegroups(string input, string expected)
    {
        Assert.Equal(expected, DeviceCodes.NormalizeUserCode(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeUserCode_EmptyOrWhitespace_ReturnsEmpty(string? input)
    {
        Assert.Equal("", DeviceCodes.NormalizeUserCode(input));
    }

    [Fact]
    public void NormalizeUserCode_WrongLength_ReturnsStrippedUpper_LookupWillMiss()
    {
        // 5 stripped chars != 8 → not regrouped; DB lookup misses (returns NotFound).
        Assert.Equal("ABCDE", DeviceCodes.NormalizeUserCode("ab-cde"));
    }

    [Fact]
    public void NormalizeUserCode_GeneratedCode_NormalizesToItself()
    {
        // The approve lookup compares NormalizeUserCode(input) == row.UserCode, and
        // rows store exactly GenerateUserCode()'s output. If a freshly-generated code
        // did not normalize to itself, every approve would miss → flow broken.
        for (var i = 0; i < 100; i++)
        {
            var code = DeviceCodes.GenerateUserCode();
            Assert.Equal(code, DeviceCodes.NormalizeUserCode(code));
        }
    }

    [Theory]
    [InlineData("wd jb-mq xr", "WDJB-MQXR")] // interior spaces stripped
    [InlineData("WDJB--MQXR", "WDJB-MQXR")]  // double dash stripped
    [InlineData("wdjbmqxr\n", "WDJB-MQXR")]  // trailing newline stripped
    public void NormalizeUserCode_StripsNonAlnum_AndRegroups(string input, string expected)
    {
        // Mirrors the frontend's lenient input handling; the canonical form must be
        // exactly what GenerateUserCode produces so the DB equality lookup hits.
        Assert.Equal(expected, DeviceCodes.NormalizeUserCode(input));
    }

    [Fact]
    public void NormalizeUserCode_LongInput_DoesNotRegroup_LookupMisses()
    {
        // 9 alnum chars != 8 → returned stripped/upper but NOT regrouped, so it can
        // never equal a stored "XXXX-XXXX" row → lookup misses (no oracle, no crash).
        Assert.Equal("ABCDEFGHJ", DeviceCodes.NormalizeUserCode("abcd-efghj"));
    }

    [Fact]
    public void HashToken_DistinctTokens_ProduceDistinctHashes()
    {
        // No accidental collision/truncation: two different device_codes must hash
        // to different values (the unique index relies on this).
        var a = DeviceCodes.HashToken(DeviceCodes.GenerateSecureToken());
        var b = DeviceCodes.HashToken(DeviceCodes.GenerateSecureToken());
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void HashToken_IsDeterministicSha256Hex()
    {
        var hash = DeviceCodes.HashToken("hello");

        // SHA256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        Assert.Equal("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", hash);
        Assert.Equal(64, hash.Length);
    }

    [Fact]
    public void HashToken_DiffersFromPlaintext_AndIsStable()
    {
        var token = DeviceCodes.GenerateSecureToken();

        var hash = DeviceCodes.HashToken(token);

        Assert.NotEqual(token, hash);
        Assert.Equal(hash, DeviceCodes.HashToken(token)); // stable
    }

    [Fact]
    public void GenerateSecureToken_IsLongRandomBase64_AndUnique()
    {
        var a = DeviceCodes.GenerateSecureToken();
        var b = DeviceCodes.GenerateSecureToken();

        Assert.NotEqual(a, b);
        // 64 random bytes → 88-char base64.
        Assert.Equal(88, a.Length);
    }
}
