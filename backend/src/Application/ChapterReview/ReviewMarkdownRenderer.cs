using System.Text;
using Contracts.ChapterReview;

namespace Application.ChapterReview;

/// <summary>
/// Renders a review into the insight's <c>Text</c>, so every existing reader of insights
/// (<c>get_my_insights</c>, both <c>BookInsightsSection</c>s) shows it with zero changes (ADR-016 §2).
/// </summary>
public static class ReviewMarkdownRenderer
{
    /// <param name="closedThreadTexts">Text of each closed thread id (they were opened in earlier
    /// chapters, so the review itself only has the id). An id without text is listed as-is.</param>
    public static string Render(
        ChapterReviewDto review, string chapterTitle, IReadOnlyDictionary<string, string>? closedThreadTexts = null)
    {
        var sb = new StringBuilder();
        sb.Append("# ").Append(chapterTitle).Append(" — chapter review\n\n");

        if (!string.IsNullOrWhiteSpace(review.Recall))
            sb.Append("**What you remembered.** ").Append(review.Recall.Trim()).Append("\n\n");

        foreach (var b in review.Blocks)
        {
            sb.Append("## ").Append(b.Title).Append("\n\n");
            sb.Append("**Example.** ").Append(b.Problem).Append("\n\n");
            sb.Append("**Root cause.** ").Append(b.RootCause).Append("\n\n");
            sb.Append("> **Rule:** ").Append(b.Rule).Append("\n\n");
            sb.Append("**Check yourself:** ").Append(b.Question.Prompt).Append("\n\n");
            sb.Append("*Answer:* ").Append(b.Question.Answer).Append("\n\n");
        }

        sb.Append("## Where this shows up\n\n");
        foreach (var a in review.Applications) sb.Append("- ").Append(a).Append('\n');

        if (review.OpenThreads.Count > 0)
        {
            sb.Append("\n## Open threads\n\n");
            foreach (var t in review.OpenThreads) sb.Append("- ").Append(t.Text).Append('\n');
        }

        if (review.ClosedThreadIds.Count > 0)
        {
            sb.Append("\n## Closed\n\n");
            foreach (var id in review.ClosedThreadIds)
                sb.Append("- ").Append(closedThreadTexts?.GetValueOrDefault(id) ?? id).Append('\n');
        }

        return sb.ToString().TrimEnd() + "\n";
    }
}
