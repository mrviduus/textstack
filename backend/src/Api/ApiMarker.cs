namespace Api;

/// <summary>
/// Entry-point marker for <c>WebApplicationFactory&lt;ApiMarker&gt;</c>. The Api, the Worker and the
/// MCP server each have a top-level <c>Program</c>, so a test project that references more than one
/// cannot name <c>Program</c> unambiguously (ADR-024).
/// </summary>
public sealed class ApiMarker;
