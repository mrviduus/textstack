using Application.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class ChapterPartsTests
{
    [Fact]
    public void Split_ShortText_SinglePart()
    {
        Assert.Equal(["short"], ChapterParts.Split("short", 100));
        Assert.Equal([""], ChapterParts.Split("", 100));
    }

    [Fact]
    public void Split_AtParagraphBoundary_Lossless()
    {
        var text = "aaaa aaaa.\n\nbbbb bbbb.\n\ncccc cccc.";

        var parts = ChapterParts.Split(text, 24);

        Assert.Equal(string.Concat(parts), text);
        Assert.All(parts, p => Assert.True(p.Length <= 24));
        Assert.Equal("aaaa aaaa.\n\nbbbb bbbb.\n\n", parts[0]);
    }

    [Fact]
    public void Split_NoParagraph_FallsBackToSentence()
    {
        var text = "One sentence here. Another one here. Third.";

        var parts = ChapterParts.Split(text, 25);

        Assert.Equal("One sentence here. ", parts[0]);
        Assert.Equal(text, string.Concat(parts));
    }

    [Fact]
    public void Split_NoBoundary_HardCut()
    {
        var text = new string('x', 95);

        var parts = ChapterParts.Split(text, 40);

        Assert.Equal([40, 40, 15], parts.Select(p => p.Length));
        Assert.Equal(text, string.Concat(parts));
    }

    [Fact]
    public void Split_ChapterSizedText_EveryPartWithinLimit_Lossless()
    {
        var paragraph = string.Join(" ", Enumerable.Repeat("Replication keeps copies of data.", 30)) + "\n\n";
        var text = string.Concat(Enumerable.Repeat(paragraph, 130)); // ~130k chars, a DDIA chapter

        var parts = ChapterParts.Split(text);

        Assert.InRange(parts.Count, 4, 5);
        Assert.All(parts, p => Assert.True(p.Length <= ChapterParts.DefaultMaxChars));
        Assert.Equal(text, string.Concat(parts));
    }
}
