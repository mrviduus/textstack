using TextStack.Extraction.Lint.Rules;

namespace TextStack.Extraction.Lint;

/// <summary>
/// Orchestrates lint rules to check content quality.
/// </summary>
public class Linter
{
    private readonly List<ILintRule> _rules;

    public Linter()
    {
        _rules =
        [
            // Typography rules
            new StraightQuotesRule(),
            new WrongDashRule(),
            new MultipleSpacesRule(),
            new MissingWordJoinerRule(),
            new InconsistentQuotesRule(),
            new DoubleSpaceAfterPeriodRule(),

            // Markup rules
            new EmptyTagRule(),
            new HeadingHierarchyRule(),
            new EmptyParagraphRule(),

            // Encoding rules
            new MojibakeRule(),
            new UnusualCharacterRule(),

            // Spelling rules
            new ArchaicSpellingRule(),

            // Semantic rules
            new UnmarkedRomanNumeralRule(),

            // Content rules
            new ScannoRule(),
            new DoubleWordRule()
        ];
    }

    /// <summary>
    /// Run all lint rules on a single chapter.
    /// </summary>
    public IEnumerable<LintIssue> LintChapter(string html, int chapterNumber)
    {
        foreach (var rule in _rules)
        {
            foreach (var issue in rule.Check(html, chapterNumber))
            {
                yield return issue;
            }
        }
    }

    /// <summary>
    /// Run all lint rules on all chapters.
    /// </summary>
    public List<LintIssue> LintAll(IReadOnlyList<(int ChapterNumber, string Html)> chapters)
    {
        var issues = new List<LintIssue>();

        foreach (var (chapterNumber, html) in chapters)
        {
            issues.AddRange(LintChapter(html, chapterNumber));
        }

        return issues;
    }
}
