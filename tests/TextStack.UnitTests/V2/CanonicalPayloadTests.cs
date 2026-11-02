using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Application.Common;

namespace TextStack.UnitTests.V2;

/// <summary>
/// RFC 8785's own test data (§3.2.3 and Appendix B), reproduced here rather than fetched, plus the
/// sync PDD's example ("Canonical JSON"). A payload hash that drifts would turn every replay of a
/// migrated operation into an <c>operation_conflict</c>.
/// </summary>
public class CanonicalPayloadTests
{
    private static string Hex(string canonical) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));

    [Fact]
    public void Canonicalize_Rfc8785Section323Example_MatchesTheRfcOutput()
    {
        var input = JsonNode.Parse("""
            {
              "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
              "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
              "literals": [null, true, false]
            }
            """);

        Assert.Equal("""{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}""",
            CanonicalPayload.Canonicalize(input));
    }

    [Fact]
    public void Canonicalize_Rfc8785SortingExample_SortsByUtf16CodeUnits()
    {
        var input = JsonNode.Parse("""
            {
              "\u20ac": "Euro Sign",
              "\r": "Carriage Return",
              "\ufb33": "Hebrew Letter Dalet With Dagesh",
              "1": "One",
              "\ud83d\ude00": "Emoji: Grinning Face",
              "\u0080": "Control",
              "\u00f6": "Latin Small Letter O With Diaeresis"
            }
            """);

        // The emoji (a surrogate pair, 0xD83D…) sorts before U+FB33, unlike by code point.
        Assert.Equal("{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\",\"\u00f6\":\"Latin Small Letter O With Diaeresis\","
            + "\"\u20ac\":\"Euro Sign\",\"\ud83d\ude00\":\"Emoji: Grinning Face\",\"\ufb33\":\"Hebrew Letter Dalet With Dagesh\"}",
            CanonicalPayload.Canonicalize(input));
    }

    [Theory]
    [InlineData(0x0000000000000000UL, "0")]
    [InlineData(0x8000000000000000UL, "0")]
    [InlineData(0x0000000000000001UL, "5e-324")]
    [InlineData(0x8000000000000001UL, "-5e-324")]
    [InlineData(0x7fefffffffffffffUL, "1.7976931348623157e+308")]
    [InlineData(0xffefffffffffffffUL, "-1.7976931348623157e+308")]
    [InlineData(0x4340000000000000UL, "9007199254740992")]
    [InlineData(0xc340000000000000UL, "-9007199254740992")]
    [InlineData(0x4430000000000000UL, "295147905179352830000")]
    [InlineData(0x44b52d02c7e14af5UL, "9.999999999999997e+22")]
    [InlineData(0x44b52d02c7e14af6UL, "1e+23")]
    [InlineData(0x44b52d02c7e14af7UL, "1.0000000000000001e+23")]
    [InlineData(0x444b1ae4d6e2ef4eUL, "999999999999999700000")]
    [InlineData(0x444b1ae4d6e2ef4fUL, "999999999999999900000")]
    [InlineData(0x444b1ae4d6e2ef50UL, "1e+21")]
    [InlineData(0x3eb0c6f7a0b5ed8cUL, "9.999999999999997e-7")]
    [InlineData(0x3eb0c6f7a0b5ed8dUL, "0.000001")]
    [InlineData(0x41b3de4355555553UL, "333333333.3333332")]
    [InlineData(0x41b3de4355555554UL, "333333333.33333325")]
    [InlineData(0x41b3de4355555555UL, "333333333.3333333")]
    [InlineData(0x41b3de4355555556UL, "333333333.3333334")]
    [InlineData(0x41b3de4355555557UL, "333333333.33333343")]
    [InlineData(0xbecbf647612f3696UL, "-0.0000033333333333333333")]
    [InlineData(0x43143ff3c1cb0959UL, "1424953923781206.2")]
    public void Canonicalize_Rfc8785AppendixBNumber_MatchesEs6Formatting(ulong ieee754, string expected) =>
        Assert.Equal(expected, CanonicalPayload.Canonicalize(JsonValue.Create(BitConverter.UInt64BitsToDouble(ieee754))));

    [Theory]
    [InlineData(0x7fffffffffffffffUL)]
    [InlineData(0x7ff0000000000000UL)]
    public void Canonicalize_NaNOrInfinity_Throws(ulong ieee754) =>
        Assert.Throws<ArgumentException>(() => CanonicalPayload.Canonicalize(JsonValue.Create(BitConverter.UInt64BitsToDouble(ieee754))));

    [Fact]
    public void Sha256_PddReviewExample_HashesTheNormalizedBytes()
    {
        var review = new
        {
            wordId = Guid.Parse("5E1A2B3C-0000-4000-8000-00000000000A"),
            isCorrect = true,
            reviewMode = "multiple_choice",
            responseTimeMs = (int?)null,
            clientRecordedAt = DateTimeOffset.Parse("2026-10-30T20:15:03.5+02:00", System.Globalization.CultureInfo.InvariantCulture),
        };

        Assert.Equal(
            Hex("""{"clientRecordedAt":"2026-10-30T18:15:03.500Z","isCorrect":true,"reviewMode":"multiple_choice","wordId":"5e1a2b3c-0000-4000-8000-00000000000a"}"""),
            CanonicalPayload.Sha256(review));
    }

    [Fact]
    public void Sha256_PascalCaseRecord_HashesCamelCaseWireNames()
    {
        Assert.Equal(Hex("""{"sentence":"A quiver.","wordKey":"quiver"}"""), CanonicalPayload.Sha256(new Example("quiver", "A quiver.", null)));
    }

    [Fact]
    public void Sha256_SubMillisecondTime_IsTruncatedNotRounded()
    {
        var at = new DateTimeOffset(2026, 10, 30, 18, 15, 3, TimeSpan.Zero).AddTicks(9_999); // 0.9999 ms

        Assert.Equal(Hex("""{"at":"2026-10-30T18:15:03.000Z"}"""), CanonicalPayload.Sha256(new { at }));
    }

    [Fact]
    public void Sha256_NestedNullsAndFractions_AreKept()
    {
        var notes = JsonNode.Parse("""[{"rect":{"x":0.5,"y":1e-7},"note":null}]""");

        Assert.Equal(Hex("""{"notes":[{"note":null,"rect":{"x":0.5,"y":1e-7}}]}"""), CanonicalPayload.Sha256(new { notes }));
    }

    private sealed record Example(string WordKey, string Sentence, string? ContextualTranslation);
}
