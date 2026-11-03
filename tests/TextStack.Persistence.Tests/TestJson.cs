using System.Text.Json.Nodes;

namespace TextStack.Persistence.Tests;

/// <summary>Locators for tests, and comparing JSON by value: jsonb keeps neither key order nor spacing.</summary>
public static class TestJson
{
    /// <summary>
    /// An <c>epub-cfi</c> position at spine item <paramref name="n"/>, quote included: it fits the fixture's EPUB files
    /// (<c>V2PostgresFixture.NewFile</c>), as a reading-state write requires (#1122).
    /// </summary>
    public static string Cfi(int n) => $$$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/{{{2 * n}}}!/4/2/1:0)","quote":"position {{{n}}}"}""";

    public static void AssertSameJson(string expected, string? actual) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), JsonNode.Parse(actual!)), $"{expected} != {actual}");
}
