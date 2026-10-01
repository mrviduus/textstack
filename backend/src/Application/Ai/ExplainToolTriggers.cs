namespace Application.Ai;

/// <summary>
/// Deterministic pre-router for Explain's tools (AI-033). The eval showed gpt-4.1-nano can't hold
/// both directions of the tool decision at once (prompt iterations swung 0.33 → 0.50 → 0.73 → 0.53,
/// always sacrificing one side): so the LEXICAL part of the decision — does the sentence even
/// contain a tool-worthy signal? — moves into code. No signal → the request carries no tool schemas
/// and the model physically cannot over-call; a signal → only the matching tool is offered and the
/// prompt's trigger guidance steers the (now near-trivial) choice. The lexical detection itself lives
/// in the shared <see cref="BookToolTriggers"/> (AI-039); this only maps signals to Explain's tool
/// names and applies the user gate. Pure; unit-tested over the golden set.
/// </summary>
public static class ExplainToolTriggers
{
    /// <summary>
    /// The tool names this sentence's wording justifies offering, in stable order. Empty when the
    /// sentence carries no tool-worthy signal — the common case, which then skips the tool round
    /// entirely. <paramref name="hasUser"/> gates the highlights tool (needs a signed-in user).
    /// (lookup_dictionary is intentionally never offered by Explain.)
    /// </summary>
    public static IReadOnlyList<string> TriggeredTools(string sentence, bool hasUser)
    {
        var signal = BookToolTriggers.Detect(sentence);
        var tools = new List<string>();
        if (signal.HasFlag(BookToolSignal.ChapterNumber))
            tools.Add("get_chapter");
        if (hasUser && signal.HasFlag(BookToolSignal.UserHighlights))
            tools.Add("get_user_highlights");
        return tools;
    }
}
