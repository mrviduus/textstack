using Application.ChapterReview;
using Contracts.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class ReviewMarkdownRendererTests
{
    private static ChapterReviewDto Review(string? recall = null, string[]? closed = null) => new(
        1, recall,
        [new ReviewBlockDto("Quorums", "Three replicas, one down.", "Reads can miss writes.", "Make w + r > n.", [],
            new ReviewQuestionDto("Why w + r > n?", "Overlap guarantees a fresh read."))],
        ["Our Cassandra cluster"],
        [new ReviewThreadDto("t_aaaaaaaa", "What about sloppy quorums?")],
        closed ?? []);

    [Fact]
    public void Render_Block_UsesTheSpecifiedShape()
    {
        var md = ReviewMarkdownRenderer.Render(Review(), "Replication");

        Assert.StartsWith("# Replication — chapter review\n", md);
        Assert.Contains("## Quorums\n\n**Example.** Three replicas, one down.\n\n**Root cause.** Reads can miss writes.\n\n> **Rule:** Make w + r > n.\n\n**Check yourself:** Why w + r > n?", md);
        Assert.Contains("*Answer:* Overlap guarantees a fresh read.", md);
        Assert.Contains("## Where this shows up\n\n- Our Cassandra cluster", md);
        Assert.Contains("## Open threads\n\n- What about sloppy quorums?", md);
        Assert.DoesNotContain("## Closed", md);
        Assert.DoesNotContain("What you remembered", md);
    }

    [Fact]
    public void Render_RecallAndClosedThreads_RenderedWithClosedText()
    {
        var md = ReviewMarkdownRenderer.Render(
            Review(recall: "Leaders and followers.", closed: ["t_bbbbbbbb", "t_cccccccc"]),
            "Replication",
            new Dictionary<string, string> { ["t_bbbbbbbb"] = "Why logs?" });

        Assert.Contains("**What you remembered.** Leaders and followers.", md);
        Assert.Contains("## Closed\n\n- Why logs?\n- t_cccccccc", md);
        Assert.EndsWith("t_cccccccc\n", md);
    }
}
