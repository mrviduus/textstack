using System.Text.Json.Serialization;
using Api.Extensions;
using Application.Auth;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

/// <summary>
/// OAuth 2.0 Device Authorization Grant (RFC 8628) — AI-050a.
/// Lets the headless MCP CLI obtain a per-user TextStack JWT:
///   1. CLI  POST /auth/device/code   → device_code + user_code + verification_uri
///   2. User POST /auth/device/approve (authed browser) with user_code
///   3. CLI  POST /auth/device/token  (polls)          → access_token + refresh_token
/// Field/error names follow RFC 8628 §3.2 / §3.5 (snake_case).
/// </summary>
public static class DeviceAuthEndpoints
{
    private const string GrantType = "urn:ietf:params:oauth:grant-type:device_code";

    public static void MapDeviceAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth/device").WithTags("Auth").RejectOAuthTokens();

        group.MapPost("/code", RequestDeviceCode).WithName("DeviceRequestCode").RequireRateLimiting("device-code");
        group.MapPost("/token", PollDeviceToken).WithName("DevicePollToken").RequireRateLimiting("device-token");
        group.MapPost("/approve", ApproveDevice).WithName("DeviceApprove").RequireRateLimiting("device-approve");
        group.MapPost("/deny", DenyDevice).WithName("DeviceDeny").RequireRateLimiting("device-approve");
    }

    private static async Task<IResult> RequestDeviceCode(
        AuthService authService,
        IConfiguration config,
        CancellationToken ct)
    {
        var result = await authService.CreateDeviceAuthorizationAsync(ct);

        var baseUrl = (config["App:BaseUrl"] ?? "https://textstack.app").TrimEnd('/');
        var verificationUri = $"{baseUrl}/device";
        var verificationUriComplete = $"{verificationUri}?code={Uri.EscapeDataString(result.UserCode)}";

        return Results.Ok(new
        {
            device_code = result.DeviceCode,
            user_code = result.UserCode,
            verification_uri = verificationUri,
            verification_uri_complete = verificationUriComplete,
            expires_in = result.ExpiresInSeconds,
            interval = result.IntervalSeconds
        });
    }

    private static async Task<IResult> PollDeviceToken(
        [FromBody] DeviceTokenRequest request,
        AuthService authService,
        CancellationToken ct)
    {
        if (!string.Equals(request.GrantType, GrantType, StringComparison.Ordinal))
            return Results.BadRequest(new { error = "unsupported_grant_type" });

        if (string.IsNullOrWhiteSpace(request.DeviceCode))
            return Results.BadRequest(new { error = "invalid_request" });

        var result = await authService.RedeemDeviceCodeAsync(request.DeviceCode, ct);

        return result.Status switch
        {
            DeviceRedeemStatus.Approved => Results.Ok(new
            {
                access_token = result.AccessToken,
                refresh_token = result.RefreshToken,
                token_type = "Bearer",
                user = ToDto(result.User!)
            }),
            DeviceRedeemStatus.AuthorizationPending => Results.BadRequest(new { error = "authorization_pending" }),
            DeviceRedeemStatus.AccessDenied => Results.BadRequest(new { error = "access_denied" }),
            _ => Results.BadRequest(new { error = "expired_token" })
        };
    }

    private static async Task<IResult> ApproveDevice(
        [FromBody] DeviceApproveRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null)
            return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.UserCode))
            return Results.BadRequest(new { error = "invalid_request" });

        var result = await authService.ApproveDeviceAsync(request.UserCode, userId.Value, ct);
        return MapApproval(result);
    }

    private static async Task<IResult> DenyDevice(
        [FromBody] DeviceApproveRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null)
            return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.UserCode))
            return Results.BadRequest(new { error = "invalid_request" });

        var result = await authService.DenyDeviceAsync(request.UserCode, ct);
        return MapApproval(result);
    }

    private static IResult MapApproval(DeviceApprovalResult result) => result switch
    {
        DeviceApprovalResult.Ok => Results.Ok(new { status = "ok" }),
        DeviceApprovalResult.NotFound => Results.BadRequest(new { error = "invalid_user_code" }),
        DeviceApprovalResult.Expired => Results.BadRequest(new { error = "expired_user_code" }),
        DeviceApprovalResult.AlreadyUsed => Results.BadRequest(new { error = "user_code_already_used" }),
        _ => Results.BadRequest(new { error = "invalid_user_code" })
    };

    private static UserDto ToDto(User user) =>
        new(user.Id, user.Email, user.Name, user.Picture, user.IsGuest, user.CreatedAt, user.NativeLanguage);

    // Bodies are JSON with snake_case keys (RFC 8628 §3.4). The frontend approve
    // call sends { "user_code": "WDJB-MQXR" }; the CLI poll sends
    // { "grant_type": "...", "device_code": "..." }.
    public record DeviceTokenRequest(
        [property: JsonPropertyName("grant_type")] string? GrantType,
        [property: JsonPropertyName("device_code")] string? DeviceCode);

    public record DeviceApproveRequest(
        [property: JsonPropertyName("user_code")] string? UserCode);
}
