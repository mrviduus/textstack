namespace TextStack.Extraction.Lint;

/// <summary>
/// Represents a single lint issue found during content analysis.
/// </summary>
public record LintIssue(
    string Code,
    LintSeverity Severity,
    string Message,
    int? ChapterNumber = null,
    int? LineNumber = null,
    string? Context = null
);

public enum LintSeverity
{
    Info,
    Warning,
    Error
}
