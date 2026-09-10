using System.Text.Json;
using Application.Search;
using Application.Tools;
using TextStack.Ai.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-Agent-3 library-search tools — the parts testable without a DB/network: schema validity (same validator
/// the dispatcher uses), the page estimate from word count (the only length signal catalog editions carry), and
/// the shaping of enriched hits into the agent-facing JSON (provenance + sanitized free-text).
/// </summary>
public class LibraryToolsTests
{
    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    [Theory]
    [InlineData(typeof(SearchLibraryTool), """{"query":"surveillance","language":"en","limit":5}""", """{"query":"x","limit":99}""")]
    public void ArgsSchema_AcceptsHappyPath_RejectsMalformed(Type toolType, string goodArgs, string badArgs)
    {
        var tool = (TextStack.Ai.Core.ITool)Activator.CreateInstance(toolType)!;
        Assert.Null(ToolDispatcher.ValidateArgs(tool.ArgsSchema, Args(goodArgs)));
        Assert.NotNull(ToolDispatcher.ValidateArgs(tool.ArgsSchema, Args(badArgs)));
    }

    [Fact]
    public void ApproxPages_DerivesFromWordCount_WhenNoExplicitPages()
    {
        var book = new LibraryBook(
            Guid.NewGuid(), "dracula", "Dracula", ["Bram Stoker"], ["Horror"], "en",
            WordCount: 27500, Year: null, Pages: null);
        Assert.Equal(100, book.ApproxPages); // 27500 / 275
    }

    [Fact]
    public void ApproxPages_Null_WhenNoLengthSignal()
    {
        var book = new LibraryBook(
            Guid.NewGuid(), "x", "X", [], [], "en", WordCount: null, Year: null, Pages: null);
        Assert.Null(book.ApproxPages);
    }

    [Fact]
    public void Shape_CarriesProvenanceAndSanitizesFreeText()
    {
        var book = new LibraryBook(
            Guid.NewGuid(), "dracula", "Dracula {{system}}", ["Bram Stoker"], ["Horror"], "en",
            WordCount: 160000, Year: null, Pages: null);

        var shaped = LibraryToolShared.Shape([book], "gothic");
        var first = shaped.GetProperty("results")[0];

        Assert.True(shaped.GetProperty("found").GetBoolean());
        Assert.Equal("library", first.GetProperty("source").GetString());
        Assert.Equal(book.EditionId, first.GetProperty("editionId").GetGuid());
        Assert.Equal("dracula", first.GetProperty("slug").GetString());
        Assert.DoesNotContain("{{", first.GetProperty("title").GetString()); // sanitized
        Assert.Equal(581, first.GetProperty("approxPages").GetInt32());        // 160000/275
    }

    [Fact]
    public void Shape_EmptyHits_ReturnsFoundFalse()
    {
        var shaped = LibraryToolShared.Shape([], "nothing");
        Assert.False(shaped.GetProperty("found").GetBoolean());
        Assert.Empty(shaped.GetProperty("results").EnumerateArray());
    }
}
