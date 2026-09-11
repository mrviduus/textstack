using Application.Auth;
using Application.Common.Interfaces;
using Api.Extensions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Api.Middleware;

/// <summary>
/// Keeps <c>users.LastActiveAt</c> true for guests, so <c>GuestCleanupWorker</c> does not delete one
/// who is still reading.
///
/// <para><b>This middleware did nothing at all until 2026-09-11.</b> It decided whether a request
/// belonged to a guest by reading <c>context.User.FindFirst("is_guest")</c> — but the API registers
/// no ASP.NET authentication middleware, by design: every endpoint resolves identity by hand through
/// <see cref="ClaimsPrincipalExtensions.GetUserId"/>. <c>HttpContext.User</c> is therefore always
/// empty, the check was always false, and the method returned on its first line for every request
/// ever served. <c>LastActiveAt</c> was only ever written once, when the guest was created.</para>
///
/// <para>The claim itself was never missing — <c>AuthService</c> has minted it into every guest's
/// access token since guest sessions shipped. It was being read from the wrong place. So the fix is
/// to resolve identity the way the rest of this API does, from the token.</para>
///
/// <para><b>What the damage actually was.</b> Narrower than it looks, and worth stating precisely
/// rather than dramatically: the cleanup filter also spares any guest holding a
/// <c>ReadingProgress</c> row, so anyone who genuinely read a book survived regardless. The exposure
/// was a guest who opened books and never produced a progress row — and, more importantly, a
/// pipeline that carried a slice doing nothing while a paragraph in <c>Program.cs</c> reasoned
/// carefully about where to put it.</para>
/// </summary>
public class GuestActivityMiddleware(RequestDelegate next)
{
    /// <summary>
    /// How long one guest's write is suppressed for. The cleanup threshold is 30 days, so this only
    /// has to be small against a month; what it is really sized for is write traffic — a reader
    /// firing a 30-second progress heartbeat would otherwise write this column 120 times an hour.
    /// </summary>
    public static readonly TimeSpan DebounceInterval = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Whether this request should write the column, given when it was last written for this guest
    /// <paramref name="lastWrittenAt"/> (null = not seen since this process started).
    ///
    /// <para>Pure, and separate from the middleware, because it is the only part with a decision in
    /// it — and because the version of this file that shipped for a year had no testable seam at
    /// all, which is part of why nobody noticed it was inert.</para>
    /// </summary>
    public static bool ShouldWrite(DateTimeOffset? lastWrittenAt, DateTimeOffset now) =>
        lastWrittenAt is not { } last || now - last >= DebounceInterval;

    public async Task InvokeAsync(HttpContext context, AuthService authService, IMemoryCache cache)
    {
        await next(context);

        // A connect key (tsk_…) is account-level and never a guest's, so the Items path that
        // McpKeyAuthMiddleware writes is deliberately not consulted here.
        var token = context.GetAccessToken();
        if (token == null) return;

        var (userId, isGuest) = authService.ValidateAccessTokenIdentity(token);
        if (!isGuest || userId is not { } id) return;

        // Debounced in memory, not by reading the row first. The previous version's debounce cost a
        // SELECT on every single guest request to decide whether to skip the UPDATE — the read it
        // was trying to avoid.
        var key = $"guest-active:{id}";
        if (!ShouldWrite(cache.Get<DateTimeOffset?>(key), DateTimeOffset.UtcNow)) return;

        try
        {
            var db = context.RequestServices.GetRequiredService<IAppDbContext>();
            // Targeted UPDATE: no entity load, no change tracking, and nothing else on the row can
            // be written by accident.
            await db.Users
                .Where(u => u.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(u => u.LastActiveAt, DateTimeOffset.UtcNow),
                    CancellationToken.None);

            cache.Set(key, DateTimeOffset.UtcNow, DebounceInterval);
        }
        catch
        {
            // Non-critical: the response has already been written, and a failure here costs a guest
            // nothing until the 30-day sweep. Deliberately NOT cached on failure, so the next
            // request retries rather than waiting out the debounce.
        }
    }
}
