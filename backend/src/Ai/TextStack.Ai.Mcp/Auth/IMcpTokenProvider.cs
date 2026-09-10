namespace TextStack.Ai.Mcp.Auth;

/// <summary>
/// Supplies the Bearer token the bridge attaches to user-scoped tool calls
/// (<c>list_my_highlights</c>, <c>list_my_vocabulary</c>).
///
/// AI-048a shipped a sync <c>string? GetToken()</c> backed by
/// <see cref="StaticEnvTokenProvider"/> (the reserved <c>TEXTSTACK_MCP_TOKEN</c>
/// env var). AI-050b makes it ASYNC and three-valued so the device-flow provider
/// (<see cref="DeviceFlowTokenProvider"/>) can refresh / start a flow on demand
/// without blocking the tool call:
///   • <see cref="TokenResult.Authorized"/> → attach Bearer, proceed.
///   • <see cref="TokenResult.Pending"/>   → a device flow is in progress; the
///     handler renders an actionable "open {uri}, enter {code}" IsError.
///   • <see cref="TokenResult.Failed"/>    → no token and no flow possible; the
///     handler renders the message as an IsError.
///
/// The provider NEVER throws for the expected no-token states (it returns
/// Pending/Failed); <see cref="Http.TextStackApiClient"/> maps those to a clean
/// <see cref="Http.McpUnauthorizedException"/> so the catalog fails-clean and the
/// HTTP call is never issued.
/// </summary>
public interface IMcpTokenProvider
{
    Task<TokenResult> GetTokenAsync(CancellationToken ct);
}

/// <summary>
/// Three-valued result of a token request. A closed hierarchy: every consumer
/// switches on exactly these three cases.
/// </summary>
public abstract record TokenResult
{
    private TokenResult() { }

    /// <summary>A usable access token — attach as <c>Bearer</c>.</summary>
    public sealed record Authorized(string AccessToken) : TokenResult;

    /// <summary>
    /// A device flow is in progress (not yet approved). The user must visit
    /// <paramref name="VerificationUri"/> and enter <paramref name="UserCode"/>;
    /// a later call returns <see cref="Authorized"/> once approved.
    /// </summary>
    public sealed record Pending(string VerificationUri, string UserCode) : TokenResult;

    /// <summary>No token is available and none can be obtained (carries why).</summary>
    public sealed record Failed(string Message) : TokenResult;
}
