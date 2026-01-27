namespace TextStack.Extraction.Lint;

/// <summary>
/// Interface for lint rules that check content quality.
/// </summary>
public interface ILintRule
{
    /// <summary>
    /// Unique code for this rule (e.g., "T001").
    /// </summary>
    string Code { get; }

    /// <summary>
    /// Human-readable description of what this rule checks.
    /// </summary>
    string Description { get; }

    /// <summary>
    /// Check the given HTML content and return any issues found.
    /// </summary>
    IEnumerable<LintIssue> Check(string html, int chapterNumber);
}
