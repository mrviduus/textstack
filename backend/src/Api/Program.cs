using Api.Endpoints;
using Api.Extensions;
using Api.Middleware;
using Application;
using Application.Identity;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.FileProviders;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// Host-level configuration (Kestrel/multipart limits + OpenTelemetry + Sentry).
var writeFreeze = builder.Configuration.GetValue<bool>(WriteFreezeMiddleware.ConfigurationKey);
builder.AddTextStackUploadLimits();
builder.AddTextStackObservability();
builder.AddTextStackSentry();

builder.Services.AddTextStackCors(builder.Configuration);
builder.Services.AddOpenApi();

// Application layer + AI platform (eval runners, agents, tools).
builder.Services
    .AddApplication()
    .AddTextStackAgents()
    .AddAuthSettings(builder.Configuration);

// storagePath is consumed again by the static-file middleware below.
var storagePath = Infrastructure.Services.FileStoreRegistration.StorageRoot(builder.Configuration);

// Persistence, product services, workers, and rate-limiting.
builder.Services
    .AddTextStackPersistence(builder.Configuration)
    .AddTextStackContentServices(builder.Configuration)
    .AddTextStackRateLimiting(builder.Configuration)
    .AddTextStackSyncApi();

// OAuth CIMD fetches go to URLs strangers choose — SSRF-guarded handler (ADR-017).
builder.Services.AddHttpClient<Api.Services.ClientMetadataFetcher>(http => http.Timeout = TimeSpan.FromSeconds(5))
    .ConfigurePrimaryHttpMessageHandler(Api.Services.ClientMetadataFetcher.CreateHandler);

// Validate required config at startup
if (!builder.Environment.IsEnvironment("Test"))
{
    if (string.IsNullOrWhiteSpace(builder.Configuration.AppConnectionString()))
        throw new InvalidOperationException("ConnectionStrings:Default is required (the textstack_v2 database).");

    var jwtSecret = builder.Configuration["Jwt:SecretKey"];
    if (string.IsNullOrEmpty(jwtSecret))
        throw new InvalidOperationException("Jwt:SecretKey is required. Set JWT_SECRET env var.");
    // A short key is fatal everywhere but Production, where refusing to start would be an outage;
    // there it is logged as Critical (reaches Sentry) once the app is built, below.
    if (Application.Identity.JwtSettings.IsWeakSecret(jwtSecret) && !builder.Environment.IsProduction())
        throw new InvalidOperationException(
            $"Jwt:SecretKey must be at least {Application.Identity.JwtSettings.MinSecretKeyBytes} bytes.");

    var googleClientId = builder.Configuration["Google:ClientId"];
    if (string.IsNullOrEmpty(googleClientId))
        throw new InvalidOperationException("Google:ClientId is required. Set GOOGLE_CLIENT_ID env var.");
}

var app = builder.Build();

if (app.Environment.IsProduction() && Application.Identity.JwtSettings.IsWeakSecret(builder.Configuration["Jwt:SecretKey"]))
    app.Logger.LogCritical(
        "Jwt:SecretKey is shorter than {MinBytes} bytes; rotate JWT_SECRET to a longer random value",
        Application.Identity.JwtSettings.MinSecretKeyBytes);

// Apple sign-in is refused without the bundle id its tokens must name: loud, not fatal.
if (string.IsNullOrWhiteSpace(builder.Configuration["Apple:BundleId"]))
    app.Logger.LogCritical("Apple:BundleId is not set; Apple sign-in is refused. Set APPLE_BUNDLE_ID");

// The `migrator` compose service owns the schema (ADR-021, ADR-026); the Api never migrates.
// A schema behind this build is reported, not fatal: throwing here would crash-loop the Api
// (restart: always) through a deliberate `migrate.sh down`. /health/ready answers 503 with the
// pending list until the migrator catches up.
if (!app.Environment.IsEnvironment("Test"))
{
    try
    {
        await using var conn = await app.Services.GetRequiredService<AppDataSource>().OpenConnectionAsync(CancellationToken.None);
        var pending = await SchemaVersion.PendingAsync(conn, SchemaVersion.Known);
        if (pending.Count > 0)
            app.Logger.LogCritical(
                "Database schema is behind this build: {PendingCount} pending migration(s), newest {NewestPending}. " +
                "The Api does not migrate. Unless the schema was rolled back on purpose (ADR-026), the migrator should run. " +
                "/health/ready is 503 until the schema matches",
                pending.Count, pending[^1]);
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Could not read the schema_migrations ledger at startup; /health/ready reports it");
    }
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}

// Forward headers from the reverse proxy chain (Cloudflare → cloudflared → nginx → here).
//
// This block decides what Connection.RemoteIpAddress is, and therefore what every per-IP rate-limit
// partition is keyed on. It was previously "trust everything, one hop", which was harmless only
// while the limiter never ran (it sat above UseRouting). Turning the limiter on made two latent
// defects live, both measured against the running stack:
//
//   1. ONE BUCKET FOR THE WHOLE INTERNET. nginx sets X-Forwarded-For with
//      $proxy_add_x_forwarded_for, which APPENDS its own $remote_addr — and its peer is cloudflared
//      on the same host, so the rightmost entry is 127.0.0.1 on every request ever made. With the
//      default ForwardLimit of 1 the middleware takes exactly that rightmost entry, so every
//      request in production resolves to the same address. Verified here: draining the bucket with
//      `XFF: 1.1.1.1, 9.9.9.9` then sending `XFF: 2.2.2.2, 9.9.9.9` returns 429 — a different
//      client behind the same proxy shares the partition. Shipped as-is, "3 guest sessions per 5
//      minutes per IP" would have meant 3 per 5 minutes for everyone on earth, and the same for
//      translate (30/min), dictionary (60/min) and tts (120/min).
//
//   2. TRIVIAL BYPASS. With KnownProxies and KnownIPNetworks both empty, ANY caller is trusted to
//      declare its own address. Verified: after exhausting the limit, three requests carrying a
//      self-chosen `X-Forwarded-For` all returned 200.
//
// The fix is the standard walk: trust hops only while they are inside the private ranges the proxy
// chain actually lives in, and keep walking right-to-left until the first address that is not.
// Cloudflare appends the true client IP to X-Forwarded-For at the edge, so anything a caller
// injects ends up to the LEFT of it and is never reached — the walk stops at the Cloudflare-written
// entry. Both defects close with the same change: the key becomes the real client, and it stops
// being caller-controlled from outside the trusted network.
var forwardedHeadersOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    // Unbounded hops: the chain length is nginx + tunnel today and must not be a magic number that
    // silently truncates to the wrong entry when a hop is added. The KnownIPNetworks list below is
    // what bounds trust, not a count.
    ForwardLimit = null,
};
forwardedHeadersOptions.KnownIPNetworks.Clear();
forwardedHeadersOptions.KnownProxies.Clear();
// Loopback + RFC1918 + IPv6 loopback/ULA: every hop between the public internet and this process
// (cloudflared, nginx, the docker bridge) is inside one of these, and no genuine client is.
foreach (var network in new[]
{
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("127.0.0.0"), 8),
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("10.0.0.0"), 8),
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("172.16.0.0"), 12),
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("192.168.0.0"), 16),
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("::1"), 128),
    new System.Net.IPNetwork(System.Net.IPAddress.Parse("fc00::"), 7),
})
{
    forwardedHeadersOptions.KnownIPNetworks.Add(network);
}
app.UseForwardedHeaders(forwardedHeadersOptions);

app.UseCors();
// Above ExceptionMiddleware so its "Unhandled exception" log carries the app version scope.
app.UseMiddleware<Api.Middleware.AppVersionMiddleware>();
app.UseExceptionMiddleware();

// Static files for uploaded content (author photos, book covers)
if (!Directory.Exists(storagePath))
{
    Directory.CreateDirectory(storagePath);
}
// Must stay before UseStaticFiles: of a reader's upload folder only the cover is public; the book
// and its images go through owner-checked /me/books/{id}/file and /assets (UserStoragePolicy).
app.Use(async (ctx, next) =>
{
    if (Api.Extensions.UserStoragePolicy.IsBlocked(ctx.Request.Path))
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }
    await next();
});
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(storagePath),
    RequestPath = "/storage",
    // Readers' uploads are served from here too (reachable as /api/storage/…). Same rule as nginx
    // /storage/: a stored file never runs as a page — no scripts, unique origin.
    OnPrepareResponse = ctx => Api.Extensions.UserStoragePolicy.ApplyStoredFileHeaders(ctx.Context.Response.Headers)
});

// Health check before site resolution (for infra probes)
app.MapGet("/health", async (AppDataSource db, ILogger<Program> logger, CancellationToken ct) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var ping = new Npgsql.NpgsqlCommand("SELECT 1", conn);
        await ping.ExecuteScalarAsync(ct);
        return Results.Ok("healthy");
    }
    catch (Exception ex)
    {
        if (!ct.IsCancellationRequested)
            logger.LogWarning(ex, "Health check: the database is unreachable");
        return Results.StatusCode(503);
    }
});

// Granular readiness probe — per-component status for ops dashboards.
// db + storage are critical (503 on failure); ollama is soft (degraded, still 200).
app.MapGet("/health/ready", async (IHttpClientFactory httpFactory, IConfiguration cfg, Api.Sync.SyncReadiness v2, AppDataSource db, ILogger<Program> logger, CancellationToken ct) =>
{
    var started = DateTimeOffset.UtcNow;
    var components = new Dictionary<string, object>();
    var criticalOk = true;

    // One connection for the db, schema and collation checks (#1364), disposed with the request.
    Npgsql.NpgsqlConnection? conn = null;
    try
    {
        conn = await db.OpenConnectionAsync(ct);
        await using var ping = new Npgsql.NpgsqlCommand("SELECT 1", conn);
        await ping.ExecuteScalarAsync(ct);
        components["db"] = new { status = "ok" };
    }
    catch (Exception ex)
    {
        components["db"] = new { status = "down", error = ex.GetType().Name };
        criticalOk = false;
    }
    await using var dbConn = conn;

    // Critical: the Api never migrates (ADR-021, ADR-026), so after `migrate.sh down`, or a
    // migrator that did not run, this build is serving against a schema it was not written for.
    // Skipped with the db down: already a 503, and a second connect timeout per probe buys nothing.
    if (!criticalOk)
        components["schema"] = new { status = "skipped" };
    else
    {
        try
        {
            var pending = await SchemaVersion.PendingAsync(conn!, SchemaVersion.Known, ct);
            if (pending.Count == 0)
                components["schema"] = new { status = "ok" };
            else
            {
                components["schema"] = new { status = "behind", pending };
                criticalOk = false;
            }
        }
        catch (Exception ex)
        {
            components["schema"] = new { status = "unknown", error = ex.GetType().Name };
            criticalOk = false;
        }
    }

    // Soft on purpose. A collation drift breaks no request today — it changes how text sorts, so a
    // btree index built under the old rules can walk past rows that are there, and a mismatched
    // template1 blocks CREATE DATABASE cluster-wide. Reporting it is the point; 503 for it would
    // take the site down for a condition that has been true for months, and the cost of gating the
    // site on something no request path needs was paid on 2026-10-30. The alarm is
    // health-check.yml, which reads this component.
    if (criticalOk)
    {
        try
        {
            var drifted = await CollationDrift.DriftedAsync(conn!, ct);
            components["collation"] = drifted.Count == 0
                ? new { status = "ok" }
                : new { status = "drift", databases = drifted };
        }
        catch (Exception ex)
        {
            components["collation"] = new { status = "unknown", error = ex.GetType().Name };
        }
    }

    // SyncReadiness's cached answer, the one /me/v2 is gated on (#1053); db and schema above are the critical checks.
    components["v2"] = await v2.GetAsync();

    // Write probes (FileStoreRegistration.ProbeWriteAsync: one fixed file per root, one probe per root at a time).
    var storageRoot = Infrastructure.Services.FileStoreRegistration.StorageRoot(cfg);
    var libraryRoot = Infrastructure.Services.FileStoreRegistration.LibraryRoot(cfg);
    var probes = await Task.WhenAll(
        Infrastructure.Services.FileStoreRegistration.ProbeWriteAsync(storageRoot, ct),
        Infrastructure.Services.FileStoreRegistration.ProbeWriteAsync(libraryRoot, ct));
    object Probe(string root, string? error) => error is null ? new { status = "ok", path = root } : new { status = "down", error };

    components["storage"] = Probe(storageRoot, probes[0]);
    criticalOk &= probes[0] is null;

    // The V2 library's own volume (#1110): unwritable is a 503 (owner decision 2026-11-07), every upload would fail.
    components["library"] = Probe(libraryRoot, probes[1]);
    criticalOk &= probes[1] is null;

    try
    {
        var baseUrl = cfg["Ollama:BaseUrl"] ?? "http://localhost:11434";
        using var client = httpFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(2);
        var resp = await client.GetAsync($"{baseUrl}/api/tags", ct);
        components["ollama"] = resp.IsSuccessStatusCode
            ? new { status = "ok" }
            : new { status = "degraded", code = (int)resp.StatusCode };
    }
    catch (Exception ex)
    {
        logger.LogInformation(ex, "Readiness: Ollama probe failed");
        components["ollama"] = new { status = "degraded" };
    }

    var elapsed = DateTimeOffset.UtcNow - started;
    var payload = new
    {
        status = criticalOk ? "ready" : "unready",
        timestamp = started,
        latencyMs = (int)elapsed.TotalMilliseconds,
        components,
    };
    return criticalOk ? Results.Ok(payload) : Results.Json(payload, statusCode: 503);
});

app.UseRouting();

// Before authentication's use stamps, guest activity and handlers. A rejected write performs no DB work here.
app.UseMiddleware<WriteFreezeMiddleware>();

// Rate limiting MUST come after UseRouting. `RequireRateLimiting("policy")` attaches
// EnableRateLimitingAttribute to ENDPOINT METADATA, and the limiter reads that metadata off
// HttpContext.GetEndpoint() — which is null until routing has matched. While this call sat above
// UseRouting (next to UseCors) every per-endpoint policy in AddTextStackRateLimiting was inert:
// 60 consecutive anonymous POST /auth/guest from one IP returned 60x 200 and zero 429, and no
// GlobalLimiter was configured to cover the gap. Anonymous User-row creation was unbounded.
//
// Placement within the post-routing segment, and why each neighbour sits where it does:
//   * ForwardedHeaders is still FIRST in the whole pipeline, so Connection.RemoteIpAddress is the
//     real client here exactly as it was before — every per-IP partition key is unaffected.
//   * ExceptionMiddleware now WRAPS the limiter instead of sitting under it; a throw from a policy
//     factory becomes a handled 500 rather than an unhandled one.
//   * GuestActivity is deliberately BELOW this line: it writes users.LastActiveAt, and a request
//     the limiter rejected must not reach the database at all.
// MCP connect keys resolve BEFORE the limiter on purpose: `highlight-write` is partitioned by
// user id rather than IP precisely because MCP traffic arrives from one container address, and it
// cannot pick that partition until the key has been resolved. See McpKeyAuthMiddleware.
app.UseMiddleware<Api.Middleware.McpKeyAuthMiddleware>();

app.UseRateLimiter();
app.UseMiddleware<AccountGuard>();

// Guest activity tracking (update LastActiveAt, debounced 10 min)
app.UseWhen(_ => !writeFreeze, branch => branch.UseMiddleware<Api.Middleware.GuestActivityMiddleware>());

// Admin auth middleware - protect /admin/* except /admin/auth/*
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/admin")
        && !ctx.Request.Path.StartsWithSegments("/admin/auth"),
    branch => branch.UseAdminAuth());

// /me → 401 without a user, /internal → 403 off the docker network (ADR-024). After McpKeyAuth so
// connect keys and OAuth tokens count as a user; after the limiter so anonymous floods still meet it.
app.UsePathGates();

app.MapAdminAuthEndpoints();
app.MapAppConfigEndpoints();
app.MapAuthEndpoints();
app.MapDeviceAuthEndpoints();
app.MapMcpManifestEndpoints();
app.MapProfileEndpoints();
app.MapAccountEndpoints();
app.MapMcpKeysEndpoints();
app.MapOAuthEndpoints();
app.MapTranslationEndpoints();
app.MapTtsEndpoints();
app.MapSyncEndpoints();
app.MapCompatEndpoints();

// CLI: create-admin command. One role since ADR-031 decided 7 (editor and moderator collapsed to admin).
if (args.Length > 0 && args[0] == "create-admin")
{
    if (args.Length < 3)
    {
        Console.WriteLine("Usage: dotnet run create-admin <email> <password>");
        return;
    }

    using var cliScope = app.Services.CreateScope();
    var adminAuthService = cliScope.ServiceProvider.GetRequiredService<IAdminAuthService>();

    var admin = await adminAuthService.CreateAdminAsync(args[1], args[2], CancellationToken.None);
    Console.WriteLine(admin is null ? $"Error: an admin with email {args[1]} already exists" : $"Admin user created: {admin.Email} ({admin.Role})");
    return;
}

app.Run();
