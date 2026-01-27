using System.Text.RegularExpressions;

namespace TextStack.Extraction.Lint.Rules;

/// <summary>
/// S001: Flags archaic spellings that weren't automatically modernized.
/// </summary>
public partial class ArchaicSpellingRule : LintRuleBase
{
    public override string Code => "S001";
    public override string Description => "Archaic spelling detected (may need manual review)";

    private static readonly (Regex Pattern, string Modern, string Note)[] ArchaicPatterns =
    [
        (ConnexionRegex(), "connection", "British archaic; may be intentional in historical context"),
        (ReflexionRegex(), "reflection", "British archaic; may be intentional in historical context"),
        (ShewRegex(), "show", "Archaic; may be intentional in historical/religious text"),
        (GaolRegex(), "jail", "British archaic; may be intentional in historical context"),
        (DespatchRegex(), "dispatch", "British archaic; may be intentional"),
        (BurthenRegex(), "burden", "Archaic; may be intentional in poetry"),
        (ClueRegex(), "clue", "Nautical 'clew' may be intentional"),
        (WaggonRegex(), "wagon", "British archaic"),
        (BehoveRegex(), "behoove", "British spelling"),
        (GreyRegex(), "gray", "British spelling; usually acceptable"),
        (StoreyRegex(), "story", "British spelling for building floor; may be correct"),
        (GauntletRegex(), "gauntlet", "'Gantlet' may be intentional (running the gantlet)"),
        (EnquireRegex(), "inquire", "British spelling; may be intentional"),
        (EncyclopaediaRegex(), "encyclopedia", "British spelling"),
        (AeonRegex(), "eon", "British spelling"),
        (FoetusRegex(), "fetus", "British medical spelling"),
        (MouldRegex(), "mold", "British spelling"),
        (SmouldRegex(), "smolder", "British spelling"),
        (PloughRegex(), "plow", "British spelling"),
        (DraughtRegex(), "draft", "British spelling; context-dependent"),
    ];

    public override IEnumerable<LintIssue> Check(string html, int chapterNumber)
    {
        if (string.IsNullOrEmpty(html))
            yield break;

        foreach (var (pattern, modern, note) in ArchaicPatterns)
        {
            foreach (Match match in pattern.Matches(html))
            {
                if (IsInsideHtmlTag(html, match.Index))
                    continue;

                yield return new LintIssue(
                    Code,
                    LintSeverity.Info,
                    $"Archaic/British spelling \"{match.Value}\" (modern: {modern}). {note}",
                    chapterNumber,
                    GetLineNumber(html, match.Index),
                    GetContext(html, match.Index)
                );
            }
        }
    }

    [GeneratedRegex(@"\b[Cc]onnexion(s)?\b")]
    private static partial Regex ConnexionRegex();

    [GeneratedRegex(@"\b[Rr]eflexion(s)?\b")]
    private static partial Regex ReflexionRegex();

    [GeneratedRegex(@"\b[Ss]hew(n|ed|ing|s)?\b")]
    private static partial Regex ShewRegex();

    [GeneratedRegex(@"\b[Gg]aol(er|s|ed)?\b")]
    private static partial Regex GaolRegex();

    [GeneratedRegex(@"\b[Dd]espatch(es|ed|ing)?\b")]
    private static partial Regex DespatchRegex();

    [GeneratedRegex(@"\b[Bb]urthen(s|ed|ing|some)?\b")]
    private static partial Regex BurthenRegex();

    [GeneratedRegex(@"\b[Cc]lew(s|ed)?\b")]
    private static partial Regex ClueRegex();

    [GeneratedRegex(@"\b[Ww]aggon(s|er|ers)?\b")]
    private static partial Regex WaggonRegex();

    [GeneratedRegex(@"\b[Bb]ehove(s|d)?\b")]
    private static partial Regex BehoveRegex();

    [GeneratedRegex(@"\b[Gg]rey(s|er|est|ish|ly|ness)?\b")]
    private static partial Regex GreyRegex();

    [GeneratedRegex(@"\b[Ss]torey(s)?\b")]
    private static partial Regex StoreyRegex();

    [GeneratedRegex(@"\b[Gg]antlet(s)?\b")]
    private static partial Regex GauntletRegex();

    [GeneratedRegex(@"\b[Ee]nquir(e|y|ies|ed|ing|er|ers)\b")]
    private static partial Regex EnquireRegex();

    [GeneratedRegex(@"\b[Ee]ncyclop(a|æ)edia(s)?\b")]
    private static partial Regex EncyclopaediaRegex();

    [GeneratedRegex(@"\b[Aa]eon(s)?\b")]
    private static partial Regex AeonRegex();

    [GeneratedRegex(@"\b[Ff](o|œ)etus(es)?\b")]
    private static partial Regex FoetusRegex();

    [GeneratedRegex(@"\b[Mm]ould(s|ed|ing|y|er)?\b")]
    private static partial Regex MouldRegex();

    [GeneratedRegex(@"\b[Ss]mould(s|ed|ing|er|ering)?\b")]
    private static partial Regex SmouldRegex();

    [GeneratedRegex(@"\b[Pp]lough(s|ed|ing|man|men)?\b")]
    private static partial Regex PloughRegex();

    [GeneratedRegex(@"\b[Dd]raught(s|y|sman|smen)?\b")]
    private static partial Regex DraughtRegex();
}
