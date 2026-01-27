namespace TextStack.Extraction.Lint;

/// <summary>
/// Base class for lint rules with common utilities.
/// </summary>
public abstract class LintRuleBase : ILintRule
{
    public abstract string Code { get; }
    public abstract string Description { get; }
    public abstract IEnumerable<LintIssue> Check(string html, int chapterNumber);

    /// <summary>
    /// Check if position is inside an HTML tag.
    /// </summary>
    protected static bool IsInsideHtmlTag(string html, int index)
    {
        var lastOpenTag = html.LastIndexOf('<', index);
        var lastCloseTag = html.LastIndexOf('>', index);
        return lastOpenTag > lastCloseTag;
    }

    /// <summary>
    /// Get context around position for error display.
    /// </summary>
    protected static string GetContext(string html, int index, int chars = 20)
    {
        var start = Math.Max(0, index - chars);
        var end = Math.Min(html.Length, index + chars);
        return html.Substring(start, end - start).Replace('\n', ' ').Replace('\r', ' ');
    }

    /// <summary>
    /// Get line number for position.
    /// </summary>
    protected static int GetLineNumber(string html, int index)
    {
        return html.Take(index).Count(c => c == '\n') + 1;
    }
}
