using Microsoft.Extensions.Options;
using Api.Extensions;
using Api.Mapping;
using Application.Auth;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AuthEndpoints
{
    // Aliased, not re-declared: the token reader in ClaimsPrincipalExtensions must name the same cookie.
    private const string AccessTokenCookie = ClaimsPrincipalExtensions.AccessTokenCookieName;
    private const string RefreshTokenCookie = "refresh_token";

    public static void MapAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/auth").WithTags("Auth").RejectOAuthTokens();

        group.MapPost("/register", Register).WithName("RegisterWithEmail").RequireRateLimiting("user-login");
        group.MapPost("/login", LoginWithEmail).WithName("LoginWithEmail").RequireRateLimiting("user-login");
        group.MapPost("/google", LoginWithGoogle).WithName("LoginWithGoogle");
        group.MapPost("/apple", LoginWithApple).WithName("LoginWithApple");
        group.MapPost("/refresh", RefreshToken).WithName("RefreshToken");
        group.MapPost("/refresh-mobile", RefreshTokenMobile).WithName("RefreshTokenMobile");
        group.MapPost("/logout", Logout).WithName("Logout");
        group.MapPost("/forgot-password", ForgotPassword).WithName("ForgotPassword").RequireRateLimiting("user-login");
        group.MapPost("/reset-password", ResetPassword).WithName("ResetPassword").RequireRateLimiting("user-login");
        group.MapPost("/guest", CreateGuestSession).WithName("CreateGuestSession").RequireRateLimiting("guest-session");
        group.MapGet("/me", GetCurrentUser).WithName("GetCurrentUser");

        if (app.Environment.IsDevelopment()
            || string.Equals(app.Configuration["ENABLE_TEST_AUTH"], "true", StringComparison.OrdinalIgnoreCase))
        {
            group.MapPost("/test-login", TestLogin).WithName("TestLogin");
        }
    }

    private static async Task<IResult> CreateGuestSession(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        // Already authenticated: never mint a second guest row, just describe the session.
        var existingUserId = httpContext.GetUserId(authService);
        if (existingUserId.HasValue)
        {
            var existingUser = await authService.GetUserByIdAsync(existingUserId.Value, ct);
            if (existingUser != null)
            {
                // Mobile has no cookie jar, so a `{user}`-only body means `accessToken:
                // undefined` at the client — and a naive signInWithTokens(res.accessToken, ...)
                // then writes that undefined over a WORKING SecureStore session and destroys it.
                // Make the endpoint total for mobile: re-issue a pair for the SAME user.
                if (IsMobileClient(httpContext))
                {
                    var (user, accessToken, refreshToken) =
                        await authService.IssueSessionAsync(existingUser, ct);
                    return Results.Ok(new MobileAuthResponse(user.ToDto(), accessToken, refreshToken));
                }

                // Web is unchanged: the cookie is already set, so re-issuing would only
                // churn refresh-token rows. Body stays `{user}`-only by contract.
                return Results.Ok(new AuthResponse(existingUser.ToDto()));
            }
        }

        var result = await authService.CreateGuestSessionAsync(ct);
        return ReturnAuthResult(result, httpContext);
    }

    private static async Task<IResult> TestLogin(
        [FromBody] TestLoginRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var result = await authService.TestLoginAsync(request.Email, ct);
        return ReturnAuthResult(result, httpContext);
    }

    private static async Task<IResult> Register(
        [FromBody] EmailRegisterRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
            return Results.BadRequest(new { error = "Email and password are required." });

        if (request.Password.Length < 8)
            return Results.BadRequest(new { error = "Password must be at least 8 characters." });

        if (request.Password.Length > 128)
            return Results.BadRequest(new { error = "Password must be at most 128 characters." });

        if (await authService.EmailExistsAsync(request.Email, ct))
            return Results.Conflict(new { error = "An account with this email already exists." });

        var guest = ResolveGuestToken(httpContext, authService);

        var result = await authService.RegisterWithEmailAsync(
            request.Email, request.Password, request.Name, guest.UserId, ct);
        if (result == null)
            return Results.BadRequest(new { error = "Invalid email or password." });

        // Registration promotes the guest IN PLACE inside RegisterWithEmailAsync (no MergeGuestAsync,
        // no cross-user re-parent), so the only way to lose data here is guest.UserId having come back
        // null from a token we DID receive. That is exactly what gets reported.
        string? skipped = null;
        if (guest.SkipReason != null)
        {
            skipped = guest.SkipReason;
            LogGuestMergeSkipped(httpContext, skipped, "/auth/register", result.Value.user.Id);
        }

        return ReturnAuthResult(result.Value, httpContext, skipped);
    }

    private static async Task<IResult> LoginWithEmail(
        [FromBody] EmailLoginRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Email) || string.IsNullOrWhiteSpace(request.Password))
            return Results.Unauthorized();

        var guest = ResolveGuestToken(httpContext, authService);

        var result = await authService.LoginWithEmailAsync(request.Email, request.Password, ct);
        if (result == null)
            return Results.Unauthorized();

        // Merge guest data into existing account
        var skipped = await MergeOrExplainAsync(
            httpContext, authService, guest, result.Value.user.Id, "/auth/login", ct);

        return ReturnAuthResult(result.Value, httpContext, skipped);
    }

    private static async Task<IResult> LoginWithGoogle(
        [FromBody] GoogleLoginRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var guest = ResolveGuestToken(httpContext, authService);

        var result = await authService.LoginWithGoogleAsync(request.IdToken, ct);
        if (result == null)
            return Results.Unauthorized();

        var skipped = await MergeOrExplainAsync(
            httpContext, authService, guest, result.Value.user.Id, "/auth/google", ct);

        return ReturnAuthResult(result.Value, httpContext, skipped);
    }

    private static async Task<IResult> LoginWithApple(
        [FromBody] AppleLoginRequest request,
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var guest = ResolveGuestToken(httpContext, authService);

        var result = await authService.LoginWithAppleAsync(
            request.IdentityToken, request.FullName, request.Email, ct);
        if (result == null)
            return Results.Unauthorized();

        var skipped = await MergeOrExplainAsync(
            httpContext, authService, guest, result.Value.user.Id, "/auth/apple", ct);

        return ReturnAuthResult(result.Value, httpContext, skipped);
    }

    private static async Task<IResult> RefreshToken(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var refreshToken = httpContext.Request.Cookies[RefreshTokenCookie];
        if (string.IsNullOrEmpty(refreshToken))
            return Results.Unauthorized();

        var result = await authService.RefreshTokenAsync(refreshToken, ct);
        if (result == null)
        {
            ClearAuthCookies(httpContext);
            return Results.Unauthorized();
        }

        return ReturnAuthResult(result.Value, httpContext);
    }

    private static async Task<IResult> RefreshTokenMobile(
        [FromBody] MobileRefreshRequest request,
        AuthService authService,
        CancellationToken ct)
    {
        var result = await authService.RefreshTokenAsync(request.RefreshToken, ct);
        if (result == null)
            return Results.Unauthorized();

        var (user, newAccessToken, newRefreshToken) = result.Value;
        return Results.Ok(new MobileAuthResponse(user.ToDto(), newAccessToken, newRefreshToken));
    }

    private static async Task<IResult> Logout(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var refreshToken = httpContext.Request.Cookies[RefreshTokenCookie];
        if (!string.IsNullOrEmpty(refreshToken))
            await authService.LogoutAsync(refreshToken, ct);

        ClearAuthCookies(httpContext);
        return Results.Ok();
    }

    private static async Task<IResult> GetCurrentUser(
        AuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null)
            return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null)
            return Results.Unauthorized();

        return Results.Ok(new AuthResponse(user.ToDto()));
    }

    private static async Task<IResult> ForgotPassword(
        [FromBody] ForgotPasswordRequest request,
        AuthService authService,
        IEmailService emailService,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Email))
            return Results.Ok(); // Don't reveal anything

        var rawToken = await authService.RequestPasswordResetAsync(request.Email, ct);
        if (rawToken != null)
        {
            await emailService.SendPasswordResetEmailAsync(request.Email.Trim(), rawToken, ct);
        }

        return Results.Ok(); // Always 200 to prevent email enumeration
    }

    private static async Task<IResult> ResetPassword(
        [FromBody] ResetPasswordRequest request,
        AuthService authService,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Token) || string.IsNullOrWhiteSpace(request.Password))
            return Results.BadRequest(new { error = "Token and password are required." });

        if (request.Password.Length < 8)
            return Results.BadRequest(new { error = "Password must be at least 8 characters." });

        var success = await authService.ResetPasswordAsync(request.Token, request.Password, ct);
        if (!success)
            return Results.BadRequest(new { error = "Invalid or expired reset link." });

        return Results.Ok();
    }

    /// <param name="guestMergeSkipped">
    /// Non-null when the sign-in succeeded but pre-sign-in guest data was deliberately not carried
    /// across. Defaulted so the paths with no guest concept (test-login, guest-session, refresh) are
    /// unchanged.
    /// </param>
    private static IResult ReturnAuthResult(
        (User user, string accessToken, string refreshToken) result,
        HttpContext httpContext,
        string? guestMergeSkipped = null)
    {
        var (user, accessToken, refreshToken) = result;
        var dto = user.ToDto();

        if (IsMobileClient(httpContext))
            return Results.Ok(new MobileAuthResponse(dto, accessToken, refreshToken, guestMergeSkipped));

        SetAuthCookies(httpContext, accessToken, refreshToken);
        return Results.Ok(new AuthResponse(dto, guestMergeSkipped));
    }

    private static void SetAuthCookies(HttpContext httpContext, string accessToken, string refreshToken)
    {
        var isProduction = !httpContext.RequestServices
            .GetRequiredService<IWebHostEnvironment>()
            .IsDevelopment();

        // Cookie lifetime must track the refresh-token TTL (JwtSettings), else the
        // browser drops the cookie before the token expires and the user is logged
        // out early despite a still-valid refresh token. Both are re-set on every
        // /auth/refresh, so an active user's window slides forward.
        var refreshTtlDays = httpContext.RequestServices
            .GetRequiredService<IOptions<JwtSettings>>()
            .Value.RefreshTokenExpiryDays;

        var options = new CookieOptions
        {
            HttpOnly = true,
            Secure = isProduction,
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromDays(refreshTtlDays),
            Path = "/"
        };

        httpContext.Response.Cookies.Append(AccessTokenCookie, accessToken, options);
        httpContext.Response.Cookies.Append(RefreshTokenCookie, refreshToken, options);
    }

    private static void ClearAuthCookies(HttpContext httpContext)
    {
        httpContext.Response.Cookies.Delete(AccessTokenCookie);
        httpContext.Response.Cookies.Delete(RefreshTokenCookie);
    }

    private static bool IsMobileClient(HttpContext httpContext)
    {
        return httpContext.Request.Headers["X-Client"].FirstOrDefault()
            ?.Equals("mobile", StringComparison.OrdinalIgnoreCase) == true;
    }

    /// <summary>
    /// The reasons a sign-in can complete WITHOUT carrying pre-sign-in guest data across. Surfaced on
    /// the auth response as <c>guestMergeSkipped</c> and logged; null/absent is the ordinary case.
    /// </summary>
    public static class GuestMergeSkipReason
    {
        /// <summary>
        /// A token WAS presented and did not validate — expired, revoked, or corrupt. Distinct from
        /// "no token at all", which is a perfectly normal registration and must stay silent.
        /// </summary>
        public const string InvalidToken = "invalid_token";

        /// <summary>The merge ran and was abandoned on a constraint violation; nothing moved.</summary>
        public const string MergeConflict = "merge_conflict";
    }

    /// <summary>
    /// What the incoming credential says about a guest to merge: the id when there is one, and a
    /// reason when there plainly WAS a session and we are about to ignore it.
    /// </summary>
    private readonly record struct GuestToken(Guid? UserId, string? SkipReason);

    /// <summary>
    /// Classifies the request's access token into: no credential / unusable credential / a real
    /// account's credential / a guest's credential.
    /// </summary>
    /// <remarks>
    /// The whole point of this method is the SECOND case. It used to collapse into the first: any
    /// token that failed validation produced the same <c>null</c> as no token at all, so the server
    /// decided to abandon a guest's accumulated highlights, vocabulary and reading history and then
    /// answered 200 without telling anyone. The client cannot see this — from its side a successful
    /// registration and a successful registration that threw away everything look identical.
    ///
    /// A mobile client refreshing an about-to-expire token before signing in closes the common case,
    /// but not the ones that matter here: a badly skewed device clock, a refresh token already
    /// rotated or revoked, a token read back corrupt from a damaged keychain. In each of those the
    /// user taps "create account", sees success, and loses everything.
    ///
    /// Deliberately NOT a 401. Someone with a stale token in their pocket and no guest data at all
    /// must still be able to register; refusing them is a worse bug than the one being fixed.
    /// Sign-in proceeds — it is just no longer silent.
    ///
    /// Reads the token through <see cref="ClaimsPrincipalExtensions.GetAccessToken"/> — the SAME
    /// reader <see cref="ClaimsPrincipalExtensions.GetUserId"/> uses. When this had its own parse,
    /// a lowercase <c>bearer</c> scheme authenticated the caller but produced an unparsable token
    /// here, so the guest was authenticated and silently not merged.
    /// </remarks>
    private static GuestToken ResolveGuestToken(HttpContext httpContext, AuthService authService)
    {
        var accessToken = httpContext.GetAccessToken();
        // No credential offered at all: an ordinary sign-in with nothing to carry. Stay quiet.
        if (accessToken == null) return default;

        var userId = authService.ValidateAccessToken(accessToken);
        if (!userId.HasValue) return new GuestToken(null, GuestMergeSkipReason.InvalidToken);

        var handler = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler();
        try
        {
            var jwt = handler.ReadJwtToken(accessToken);
            var isGuest = jwt.Claims.FirstOrDefault(c => c.Type == "is_guest")?.Value;
            // A valid NON-guest token is not suspicious — an account re-authenticating has nothing
            // to merge, and flagging it would drown the signal we actually care about.
            return isGuest == "true" ? new GuestToken(userId, null) : default;
        }
        catch
        {
            // Validated a moment ago, so this is close to unreachable — but if the token is somehow
            // unreadable we are once again about to drop guest data, which is the reportable event.
            return new GuestToken(null, GuestMergeSkipReason.InvalidToken);
        }
    }

    /// <summary>
    /// Runs the merge if there is one to run, and returns the value for the response's
    /// <c>guestMergeSkipped</c> field (null when nothing was skipped).
    /// </summary>
    private static async Task<string?> MergeOrExplainAsync(
        HttpContext httpContext,
        AuthService authService,
        GuestToken guest,
        Guid realUserId,
        string route,
        CancellationToken ct)
    {
        if (guest.SkipReason != null)
        {
            LogGuestMergeSkipped(httpContext, guest.SkipReason, route, realUserId);
            return guest.SkipReason;
        }

        if (!guest.UserId.HasValue) return null;

        if (await authService.MergeGuestAsync(guest.UserId.Value, realUserId, route, ct))
            return null;

        LogGuestMergeSkipped(httpContext, GuestMergeSkipReason.MergeConflict, route, realUserId);
        return GuestMergeSkipReason.MergeConflict;
    }

    /// <summary>
    /// One structured Warning per dropped guest session, shaped so the rate can be counted in
    /// production by reason and route rather than inferred from support tickets.
    /// </summary>
    /// <remarks>
    /// <c>expiresAt</c> is read from the token WITHOUT validating it — no trust decision rests on
    /// it, it is there so an ops query can separate "clocks/expiry" from "corrupt or revoked", which
    /// are different bugs with different fixes. The token itself is never logged.
    /// </remarks>
    private static void LogGuestMergeSkipped(
        HttpContext httpContext, string reason, string route, Guid realUserId)
    {
        var logger = httpContext.RequestServices
            .GetRequiredService<ILoggerFactory>()
            .CreateLogger(GuestMergeLogCategory);

        DateTime? expiresAt = null;
        try
        {
            var token = httpContext.GetAccessToken();
            if (token != null)
                expiresAt = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler()
                    .ReadJwtToken(token).ValidTo;
        }
        catch
        {
            // Unreadable token — that IS the answer, and `expiresAt: null` records it.
        }

        logger.LogWarning(
            "Guest merge skipped on {Route}: {Reason}. Sign-in completed for {RealUserId}; "
            + "pre-sign-in guest data was NOT carried across. Token expiry {TokenExpiresAt}, "
            + "mobile client {IsMobile}",
            route, reason, realUserId, expiresAt, IsMobileClient(httpContext));
    }

    private const string GuestMergeLogCategory = "Api.Endpoints.AuthEndpoints.GuestMerge";
}
