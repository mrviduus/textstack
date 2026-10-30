using System.Text.Json.Nodes;

namespace TextStack.Persistence.Tests;

/// <summary>Locators for tests, and comparing JSON by value: jsonb keeps neither key order nor spacing.</summary>
public static class TestJson
{
    /// <summary>A <c>pdf-page</c> locator envelope for one page.</summary>
    public static string Page(int page) => $$$"""{"version":1,"scheme":"pdf-page","value":{"page":{{{page}}}}}""";

    public static void AssertSameJson(string expected, string? actual) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), JsonNode.Parse(actual!)), $"{expected} != {actual}");
}
