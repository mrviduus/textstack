namespace Api.Extensions;

/// <summary>
/// "This capability needs a real account." One policy, applied at the route, rather than an
/// <c>if (user.IsGuest)</c> copied into a dozen handlers.
/// </summary>
/// <remarks>
/// It exists because the mobile client's <c>canUseAi = isAccount</c> is a UI affordance and not a
/// boundary: a guest session mints a perfectly valid bearer token, so before this every paid-inference
/// endpoint answered a guest with a real LLM call and an IP rate limit as its only barrier. Deliberately
/// NOT applied to translate, dictionary or TTS — those are anonymous on purpose and the reading loop
/// depends on them.
/// </remarks>
public static class AiAccountPolicy
{
    /// <summary>Machine-readable code clients branch on to show "create a free account".</summary>
    public const string ErrorCode = "account_required";

    /// <summary>
    /// 403 <see cref="ErrorCode"/> for a guest connecting an assistant (OAuth consent, MCP connect keys):
    /// a persistent assistant credential needs a real account (#1120).
    /// </summary>
    public static IResult AssistantAccountRequired() => Results.Problem(
        title: "Account required",
        detail: "Create a free account to connect an assistant.",
        statusCode: StatusCodes.Status403Forbidden,
        extensions: new Dictionary<string, object?> { ["error"] = ErrorCode });
}
