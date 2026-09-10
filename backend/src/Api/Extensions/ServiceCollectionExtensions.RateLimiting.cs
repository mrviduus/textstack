using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// All rate-limiter policies (login, device grant, guest, clip/upload, TTS,
    /// translation, dictionary, explain, semantic search, RAG, agents, crews,
    /// account-delete) plus the shared rejection/Retry-After behavior.
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = userLoginPermitLimit,
                    QueueLimit = 0,
                });
            });
            // Device Authorization Grant (RFC 8628, AI-050a) — all per-IP.
            // device-code: CLI requests a device_code; one per CLI session, 5/min is ample.
            options.AddPolicy("device-code", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 5,
                    QueueLimit = 0,
                });
            });
            // device-token: CLI polls the token endpoint ~every 5s (interval); 12/min covers
            // honest polling with headroom and still caps scripted abuse.
            options.AddPolicy("device-token", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = clipPermitLimit,
                    QueueLimit = 0,
                });
            });
            // Highlight writes (POST /me/highlights) — the one policy in this file NOT partitioned
            // by IP, and deliberately so. This endpoint is reached both by a person in the reader and
            // by an MCP client, and the MCP bridge talks to the API over the internal docker network:
            // every assistant write in the deployment arrives from the one container address. Keyed
            // by IP, a single looping client would throttle every other MCP user with it, while a
            // person behind a shared NAT could be throttled by a stranger. The account is what owns
            // the rows being written, so the account is the partition.
            //
            // The ceiling that stops a book being marked to illegibility is a COUNT, not a rate —
            // HighlightsEndpoints.MaxAssistantHighlightsPerBook. This is only the loop guard: high
            // enough that a person highlighting hard, or a client syncing an offline queue after a
            // flight, never meets it.
            options.AddPolicy("highlight-write", httpContext =>
            {
                var auth = httpContext.RequestServices.GetRequiredService<Application.Auth.AuthService>();
                // Pure JWT validation, no database call — safe on the limiter's hot path. Falls back
                // to the IP when there is no usable token; the endpoint answers 401 anyway.
                var key = httpContext.GetUserId(auth)?.ToString()
                    ?? httpContext.Connection.RemoteIpAddress?.ToString()
                    ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 120,
                    QueueLimit = 0,
                });
            });
            // Insights (POST /me/insights) — the write-back an outside assistant makes after a
            // reading session. Cheap for us (one row, no inference), so the cap is not about cost:
            // it is about a runaway agent loop rewriting a book's конспект thousands of times. 60/min
            // clears a model working chapter by chapter through a long book in one pass and stops a
            // loop dead.
            options.AddPolicy("insights", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 60,
                    QueueLimit = 0,
                });
            });
            // Connect-key creation — per-IP. Minting a credential is rare and deliberate: a reader
            // does it once per assistant. The cap exists so a scripted client cannot fill the
            // per-user key list (McpKeys.MaxKeysPerUser) over and over as fast as it likes.
            options.AddPolicy("mcp-keys", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(5),
                    PermitLimit = 10,
                    QueueLimit = 0,
                });
            });
            // User book upload — per-IP cap, mirrors the clip zone. Uploads are heavier
            // (file ingestion) so the same conservative bucket applies.
            options.AddPolicy("user-upload", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 20,
                    QueueLimit = 0,
                });
            });
            // Metadata re-enrich (POST /me/books/{id}/enrich) — a cheap idempotent re-trigger that just flips
            // the book back to Pending, but each incomplete-book run spins a paid EnrichmentAgent (several LLM
            // calls) on the worker. A modest per-IP cap blocks scripted re-trigger loops while staying out of
            // the way of a human re-running enrichment on a handful of books.
            options.AddPolicy("enrich", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 5,
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 30,
                    QueueLimit = 0,
                });
            });
            // Dictionary lookup — per-IP. Proxies Free Dictionary API (cheap,
            // public). Users tap words rapidly while reading; 60/min fits the
            // natural pace and still caps scripted abuse.
            options.AddPolicy("dictionary", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 60,
                    QueueLimit = 0,
                });
            });
            // /explain — Claude/OpenAI-backed contextual explanation. Paid API
            // call per miss (cache fronts it). 20/min per IP is plenty for
            // active reading; anything higher smells like scripting.
            options.AddPolicy("explain", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 20,
                    QueueLimit = 0,
                });
            });
            // Hybrid catalog search (AI-057): semantic=true embeds the query (one paid OpenAI embedding
            // call per request) before the $0 pgvector scan, so it gets its own per-IP throttle. CRITICAL:
            // this policy is a NO-OP unless `semantic` is truthy — the pure-FTS path (semantic absent/false)
            // consumes no partition and stays completely unthrottled (zero new cost/latency).
            options.AddPolicy("search-semantic", httpContext =>
            {
                var semantic = httpContext.Request.Query["semantic"].ToString();
                var isSemantic = semantic.Equals("true", StringComparison.OrdinalIgnoreCase)
                                 || semantic == "1";
                if (!isSemantic)
                    return RateLimitPartition.GetNoLimiter("search-fts");

                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter("semantic:" + ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 20,
                    QueueLimit = 0,
                });
            });
            // "Ask this book" (RAG) — one LLM call per request, per-user reading. 30/min per IP is
            // generous for genuine use and caps scripted abuse.
            options.AddPolicy("rag.ask", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = rateLimits.EffectiveRagAskPermitLimit,
                    QueueLimit = 0,
                });
            });
            // On-demand "Ask this book" index trigger (Phase 1): per-IP cap so a user can't mass-index
            // the whole catalog. ~20/hour — generous for legit "index this book then poll" flows.
            options.AddPolicy("rag.index", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromHours(1),
                    PermitLimit = 20,
                    QueueLimit = 0,
                });
            });
            // Librarian agent (AI-Agent-3): each run is several LLM calls + maybe external HTTP, so a tight per-IP cap.
            options.AddPolicy("librarian", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 8,
                    QueueLimit = 0,
                });
            });
            // Learning Tutor agent (AI-Agent-2): each planning turn is several LLM calls + DB reads, so a tight per-IP
            // cap. Mirrors the librarian policy shape.
            options.AddPolicy("tutor", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 8,
                    QueueLimit = 0,
                });
            });
            // AutoPublish crew (AI-042): an admin generate is TWO 4-stage crews = 8 LLM calls, so a tight per-IP cap.
            // Mirrors the librarian policy shape; it sits behind admin auth too, this is just runaway protection.
            options.AddPolicy("autopublish.crew", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 4,
                    QueueLimit = 0,
                });
            });
            // SEO crew (AI-043): one 4-stage crew = 4 LLM calls per admin generate. Same tight per-IP cap as
            // autopublish.crew; sits behind admin auth too, this is just runaway protection.
            options.AddPolicy("seo.crew", httpContext =>
            {
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                return RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
                {
                    Window = TimeSpan.FromMinutes(1),
                    PermitLimit = 4,
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
                var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
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
}
