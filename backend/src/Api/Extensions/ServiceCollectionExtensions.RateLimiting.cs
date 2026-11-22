using System.Net;
using System.Net.Sockets;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// All rate-limiter policies (login, device grant, guest, clip, insights, assistant writes, OAuth,
    /// MCP keys, TTS, translation, explain, account-delete) plus the shared rejection/Retry-After behavior.
    /// <para>
    /// Originally a verbatim move from Program.cs. Since then two things changed, both forced by the
    /// limiter actually being reached (it used to sit above <c>UseRouting</c> and never ran):
    /// <c>admin-login</c>/<c>user-login</c> are now per-IP rather than one global bucket, and
    /// <c>user-login</c>'s permit limit is configurable. No window and no ceiling was loosened.
    /// </para>
    /// </summary>
    public static IServiceCollection AddTextStackRateLimiting(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        // Read once at registration: the policy factories below run per request and must not
        // re-bind configuration on the hot path.
        var rateLimits = configuration.GetSection(RateLimitSettings.SectionName).Get<RateLimitSettings>()
            ?? new RateLimitSettings();
        services.Configure<RateLimitSettings>(configuration.GetSection(RateLimitSettings.SectionName));

        services.AddRateLimiter(options =>
        {
            // admin-login / user-login are per-IP, like every other policy in this file. They were
            // GLOBAL single buckets — 5 and 10 attempts per minute for the entire site — which was
            // harmless only for as long as the limiter never ran (it sat above UseRouting, so no
            // per-endpoint policy was ever consulted; see Program.cs). Switching it on made that
            // shape live, and a global login bucket is not a stronger brute-force defence: an
            // attacker with a handful of IPs defeats it either way, while any single script hitting
            // /auth/login ten times locks EVERY user out of signing in — including password reset,
            // which shares the policy. Partitioning keeps the same per-attacker ceiling and removes
            // the collateral.
            options.AddPolicy("admin-login", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 5,
                    QueueLimit = 0,
                });
            });
            // The permit limit is a deployment knob for the same reason the guest one is: the
            // guest-merge suite makes ~15 register+login calls from a single host inside one minute,
            // so at the production value CI would throttle itself into skips and report green with
            // no merge coverage at all. Window, partition key and policy are identical everywhere —
            // a knob, not a test-only bypass.
            var userLoginPermitLimit = rateLimits.EffectiveUserLoginPermitLimit;
            options.AddPolicy("user-login", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = userLoginPermitLimit,
                    QueueLimit = 0,
                });
            });
            // Device Authorization Grant (RFC 8628, AI-050a) — all per-IP.
            // device-code: CLI requests a device_code; one per CLI session, 5/min is ample.
            // Configurable (RateLimits:DeviceCodePermitLimit) for the integration suite only.
            var deviceCodePermitLimit = rateLimits.EffectiveDeviceCodePermitLimit;
            options.AddPolicy("device-code", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = deviceCodePermitLimit,
                    QueueLimit = 0,
                });
            });
            // device-token: CLI polls the token endpoint ~every 5s (interval); 12/min covers
            // honest polling with headroom and still caps scripted abuse.
            options.AddPolicy("device-token", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 12,
                    QueueLimit = 0,
                });
            });
            // device-approve: authed consent action; one submit per CLI session. 10/min per IP.
            options.AddPolicy("device-approve", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 10,
                    QueueLimit = 0,
                });
            });
            // Per-IP partition — bot with one IP can't exhaust the limit for everyone.
            // 3 guest-creates per 5min per IP: covers legit shared-WiFi cases, blocks scripted abuse.
            // ForwardedHeaders runs before RateLimiter in the pipeline, so RemoteIpAddress is the real client.
            //
            // The permit limit is the one value here that a deployment moves: the guest-merge
            // integration suite needs >=6 guests and CI drives every request from a single host,
            // so CI raises RateLimits__GuestSessionPermitLimit in compose. The window, the
            // partition key, and the policy itself are identical in CI and production — there is
            // no test-only bypass, so a regression in the limiter still fails a test.
            var guestSessionPermitLimit = rateLimits.EffectiveGuestSessionPermitLimit;
            options.AddPolicy("guest-session", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(5),
                    PermitLimit = guestSessionPermitLimit,
                    QueueLimit = 0,
                });
            });
            // "Send to TextStack" web clip receiver — per-IP cap. Each clip queues an
            // ingestion job + stores HTML, so this blocks scripted bulk-clipping while
            // staying generous for a human saving a handful of articles in a session.
            // Permit limit is a knob for the same reason as the guest one: a dozen integration test
            // classes seed a user book by clipping one, so a single suite run exceeds 20 from one
            // host and they all skip on "clip seed unavailable" instead of running.
            var clipPermitLimit = rateLimits.EffectiveClipPermitLimit;
            options.AddPolicy("clip", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = clipPermitLimit,
                    QueueLimit = 0,
                });
            });
            // The V2 writes an assistant makes (annotations, vocabulary): 120/min per account, only for a caller on
            // an MCP connect key or OAuth token (McpKeyAuth). Per account, not IP: every MCP write arrives from the
            // bridge's one container address. A reader's device is never limited here: its
            // first sync pushes a whole outbox at once, and a 429 there parks the entries.
            options.AddPolicy("assistant-write", httpContext =>
                httpContext.Items[Api.Middleware.McpKeyAuthMiddleware.UserIdItemKey] is Guid assistantUser
                    ? RateLimitPartition.GetFixedWindowLimiter(assistantUser.ToString(), _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 120,
                        QueueLimit = 0,
                    })
                    : RateLimitPartition.GetNoLimiter("reader"));
            // Insights (POST /me/v2/books/{id}/insights) — the write-back an outside assistant makes after a
            // reading session. Cheap for us (one row, no inference), so the cap is not about cost:
            // it is about a runaway agent loop rewriting a book's конспект thousands of times. 60/min
            // clears a model working chapter by chapter through a long book in one pass and stops a
            // loop dead.
            //
            // Partitioned by user, like assistant-write and for the same reason: every MCP write
            // arrives from the bridge's one container address, so an IP key made 60/min a budget
            // shared by every MCP user in the deployment.
            options.AddPolicy("insights", httpContext =>
            {
                var auth = httpContext.RequestServices.GetRequiredService<Application.Identity.IAuthService>();
                var key = httpContext.GetUserId(auth)?.ToString()
                    ?? IpPartitionKey(httpContext.Connection.RemoteIpAddress)
                    ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 60,
                    QueueLimit = 0,
                });
            });
            // Connect-key creation — per-IP. Minting a credential is rare and deliberate: a reader
            // does it once per assistant. The cap exists so a scripted client cannot fill the
            // per-user key list (McpKeys.MaxKeysPerUser) over and over as fast as it likes.
            // OAuth AS (ADR-017), per IP. Two shapes: "browser" is a reader's own address hitting
            // authorize/consent — one connect is a handful of requests. "server" is token/register/
            // revoke, called from Anthropic's and OpenAI's egress, so ONE IP stands for every user of
            // that platform: the ceiling is sized for the platform, not the person.
            // ponytail: fixed per-IP ceilings; make them RateLimits knobs if a platform nears 120/min.
            options.AddPolicy("oauth-browser", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 30,
                    QueueLimit = 0,
                });
            });
            options.AddPolicy("oauth-server", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 120,
                    QueueLimit = 0,
                });
            });
            // Configurable (RateLimits:McpKeysPermitLimit) for the integration suite only.
            var mcpKeysPermitLimit = rateLimits.EffectiveMcpKeysPermitLimit;
            options.AddPolicy("mcp-keys", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(5),
                    PermitLimit = mcpKeysPermitLimit,
                    QueueLimit = 0,
                });
            });
            // TTS synthesis — per-IP cap. Generous enough for bursty vocab-review /
            // reader-tap usage (~2/s average, tolerates ~20-req bursts via window
            // timing), but blocks scripted abuse hammering the upstream Bing WS.
            // ETag + server+client cache mean most requests are cheap; this limit
            // primarily protects synthesis (uncached) throughput.
            options.AddPolicy("tts", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 120,
                    QueueLimit = 0,
                });
            });
            // TTS voices list — cheap (served from 24h server cache), typically
            // called once per session at voice-picker mount. Separate bucket with
            // a much higher cap so a user burning through synthesis budget can
            // still open the voice picker.
            options.AddPolicy("tts-voices", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 600,
                    QueueLimit = 0,
                });
            });
            // Translation — per-IP. OpenAI is the upstream cost; users
            // typically call 1-3 times per reading session via SelectionToolbar.
            // 30/min is generous for normal UX, blocks scripted scraping of the
            // translation service.
            options.AddPolicy("translate", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 30,
                    QueueLimit = 0,
                });
            });
            // /explain — Claude/OpenAI-backed contextual explanation. Paid API
            // call per miss (cache fronts it). 20/min per IP is plenty for
            // active reading; anything higher smells like scripting.
            options.AddPolicy("explain", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 20,
                    QueueLimit = 0,
                });
            });
            // Account deletion — destructive and irreversible (GDPR hard delete). A user
            // never needs to call this more than once, so a tight per-IP cap blocks abuse
            // (e.g. scripted churn against the cascade delete) while staying out of the way
            // of a legitimate retry after a transient failure.
            // Knob, same doctrine: the GDPR delete suite legitimately calls this four times in one
            // class, which is one more than production wants to allow a human.
            var accountDeletePermitLimit = rateLimits.EffectiveAccountDeletePermitLimit;
            options.AddPolicy("account-delete", httpContext =>
            {
                var ip = IpPartitionKey(httpContext.Connection.RemoteIpAddress) ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(5),
                    PermitLimit = accountDeletePermitLimit,
                    QueueLimit = 0,
                });
            });
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            // Emit Retry-After so clients can back off intelligently instead of
            // hammering in a tight retry loop. RateLimiter exposes the metadata
            // via lease.TryGetMetadata when available.
            options.OnRejected = (context, ct) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                {
                    var seconds = (int)Math.Ceiling(retryAfter.TotalSeconds);
                    context.HttpContext.Response.Headers.RetryAfter = seconds.ToString();
                }
                return ValueTask.CompletedTask;
            };
        });

        return services;
    }

    /// <summary>
    /// The per-IP partition key. IPv6 is keyed by its /64: a /64 is the usual allocation to a single
    /// subscriber, so it — not the full address — is the unit that identifies one client. IPv4 is
    /// the address itself; an IPv4-mapped IPv6 address counts as the IPv4 it carries. Null in, null out.
    /// </summary>
    internal static string? IpPartitionKey(IPAddress? ip)
    {
        if (ip is null) return null;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.AddressFamily != AddressFamily.InterNetworkV6) return ip.ToString();

        var bytes = ip.GetAddressBytes();
        Array.Clear(bytes, 8, 8);
        return $"{new IPAddress(bytes)}/64";
    }
}
