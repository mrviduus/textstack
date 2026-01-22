using System.Threading.RateLimiting;
using Api.Endpoints;
using Api.Language;
using Api.Middleware;
using Api.Sites;
using Application;
using Application.AdminAuth;
using Application.Common.Interfaces;
using Application.TextStack;
using Domain.Enums;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Infrastructure.Telemetry;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.FileProviders;
using Npgsql;
using OnlineLib.Search;
using OnlineLib.Search.Abstractions;
using OpenTelemetry.Trace;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// OpenTelemetry
builder.Services.AddOnlineLibTelemetry(
    builder.Configuration,
    "onlinelib-api",
    tracing => tracing
        .AddAspNetCoreInstrumentation(options =>
        {
            options.RecordException = true;
            options.EnrichWithHttpRequest = (activity, request) =>
            {
                activity.SetTag("http.client_ip", request.HttpContext.Connection.RemoteIpAddress?.ToString());
            };
        })
        .AddHttpClientInstrumentation());
builder.Logging.AddTelemetryLogging(builder.Configuration, "onlinelib-api");

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(
                // Dev: public site
                "http://localhost:5173",
                "http://general.localhost",
                "http://general.localhost:5173",
                // Dev: admin panel
                "http://localhost:5174",
                "http://admin.localhost",
                "http://admin.localhost:5174",
                // Prod: public site
                "https://textstack.app",
                // Prod: admin panel
                "https://textstack.dev"
            )
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

builder.Services.AddOpenApi();

// Application layer
builder.Services.AddApplication();
builder.Services.AddAuthSettings(builder.Configuration);

var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? "Host=localhost;Port=5432;Database=books;Username=app;Password=changeme";

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(connectionString)
        .UseSnakeCaseNamingConvention()
        .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));

builder.Services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());

// File storage
var storagePath = builder.Configuration["Storage:RootPath"] ?? "/storage";
builder.Services.AddSingleton<IFileStorageService>(new LocalFileStorageService(storagePath));

// Search library
builder.Services.AddOnlineLibSearch();
builder.Services.AddPostgresFtsProvider(
    _ => () => new NpgsqlConnection(connectionString),
    options => options.ConnectionString = connectionString);

// Site resolution
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<ISiteResolver, SiteResolver>();

// TextStack import
builder.Services.AddScoped<TextStackImportService>();

// Standard Ebooks sync
builder.Services.AddHttpClient<StandardEbooksSyncService>();
builder.Services.AddScoped<StandardEbooksSyncService>();


// Rate limiting for admin login
builder.Services.AddRateLimiter(options =>
{
    options.AddFixedWindowLimiter("admin-login", opt =>
    {
        opt.Window = TimeSpan.FromMinutes(1);
        opt.PermitLimit = 5;
        opt.QueueLimit = 0;
    });
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
});

var app = builder.Build();

// Skip migrations in Test environment (uses InMemory DB)
if (!app.Environment.IsEnvironment("Test"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}

// Forward headers from reverse proxy (nginx/cloudflare)
var forwardedHeadersOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
// Trust all proxies in production (behind nginx/cloudflare)
forwardedHeadersOptions.KnownNetworks.Clear();
forwardedHeadersOptions.KnownProxies.Clear();
app.UseForwardedHeaders(forwardedHeadersOptions);

app.UseCors();
app.UseRateLimiter();
app.UseExceptionMiddleware();

// Static files for uploaded content (author photos, book covers)
if (!Directory.Exists(storagePath))
{
    Directory.CreateDirectory(storagePath);
}
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(storagePath),
    RequestPath = "/storage"
});

// Health check before site resolution (for infra probes)
app.MapGet("/health", () => Results.Ok("healthy"));

// Site resolution middleware
app.UseSiteContext();

// Language resolution middleware (after site context)
app.UseLanguageContext();

// Explicit routing after middleware so path rewriting works
app.UseRouting();

// Admin auth middleware - protect /admin/* except /admin/auth/*
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/admin")
        && !ctx.Request.Path.StartsWithSegments("/admin/auth"),
    branch => branch.UseAdminAuth());

app.MapAdminAuthEndpoints();
app.MapAdminEndpoints();
app.MapAdminAuthorsEndpoints();
app.MapAdminGenresEndpoints();
app.MapAdminSeoCrawlEndpoints();
app.MapBooksEndpoints();
app.MapSearchEndpoints();
app.MapAuthorsEndpoints();
app.MapGenresEndpoints();
app.MapSiteEndpoints();
app.MapSeoEndpoints();
app.MapSsgEndpoints();
app.MapAuthEndpoints();
app.MapUserDataEndpoints();

// CLI: import-textstack command
if (args.Length > 0 && args[0] == "import-textstack")
{
    if (args.Length < 2)
    {
        Console.WriteLine("Usage: dotnet run import-textstack <book-path>");
        return;
    }

    var bookPath = args[1];
    if (!Directory.Exists(bookPath))
    {
        Console.WriteLine($"Directory not found: {bookPath}");
        return;
    }

    using var cliScope = app.Services.CreateScope();
    var db = cliScope.ServiceProvider.GetRequiredService<IAppDbContext>();
    var importService = cliScope.ServiceProvider.GetRequiredService<TextStackImportService>();

    // Get "general" site
    var site = await db.Sites.FirstOrDefaultAsync(s => s.Code == "general");
    if (site == null)
    {
        Console.WriteLine("Site 'general' not found");
        return;
    }

    Console.WriteLine($"Importing from: {bookPath}");
    var result = await importService.ImportBookAsync(site.Id, bookPath, CancellationToken.None);

    if (result.WasSkipped)
        Console.WriteLine("Book already imported, skipped.");
    else if (result.Error != null)
        Console.WriteLine($"Error: {result.Error}");
    else
        Console.WriteLine($"Success! Edition: {result.EditionId}, Chapters: {result.ChapterCount}");

    return;
}

// CLI: create-admin command
if (args.Length > 0 && args[0] == "create-admin")
{
    if (args.Length < 3)
    {
        Console.WriteLine("Usage: dotnet run create-admin <email> <password> [role]");
        Console.WriteLine("Roles: Admin (default), Editor, Moderator");
        return;
    }

    var email = args[1];
    var password = args[2];
    var role = AdminRole.Admin;

    if (args.Length >= 4 && Enum.TryParse<AdminRole>(args[3], true, out var parsedRole))
        role = parsedRole;

    using var cliScope = app.Services.CreateScope();
    var adminAuthService = cliScope.ServiceProvider.GetRequiredService<AdminAuthService>();

    try
    {
        var admin = await adminAuthService.CreateAdminUserAsync(email, password, role, CancellationToken.None);
        Console.WriteLine($"Admin user created: {admin.Email} ({admin.Role})");
    }
    catch (InvalidOperationException ex)
    {
        Console.WriteLine($"Error: {ex.Message}");
    }

    return;
}

app.Run();
