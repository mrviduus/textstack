using Api.Middleware;
using Application.AdminSettings;
using Application.Agents;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Core;

namespace Api.Endpoints;

public static class AdminAutoPublishEndpoints
{
    public static void MapAdminAutoPublishEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/autopublish").WithTags("Auto Publish");

        group.MapGet("/settings", GetSettings);
        group.MapPut("/settings", UpdateSettings);
        group.MapGet("/jobs", GetJobs);
        group.MapGet("/jobs/{id:guid}", GetJob);
        group.MapPost("/jobs/{id:guid}/approve", ApproveJob);
        group.MapPost("/jobs/{id:guid}/reject", RejectJob);
        group.MapPost("/jobs/{id:guid}/retry", RetryJob);
        group.MapPost("/trigger", Trigger);
        group.MapPost("/queue/{editionId:guid}", QueueEdition);
        group.MapGet("/candidates", GetCandidates);

        // AI-042: in-process crew path — runs the AI-041 specialists over ILlmService to generate SEO prose.
        // Behind the same /admin/* auth group; rate-limited (each call = two 4-stage crews = 8 LLM calls).
        group.MapPost("/editions/{editionId:guid}/crew-generate", CrewGenerate)
            .RequireRateLimiting("autopublish.crew");
    }

    private static async Task<IResult> GetSettings(AdminSettingsService settings, CancellationToken ct)
    {
        return Results.Ok(new AutoPublishSettingsDto(
            Enabled: await settings.GetBoolAsync("autopublish.enabled", false, ct),
            BooksPerDay: await settings.GetIntAsync("autopublish.booksPerDay", 1, ct),
            HourUtc: await settings.GetIntAsync("autopublish.hourUtc", 10, ct),
            RequireReview: await settings.GetBoolAsync("autopublish.requireReview", false, ct),
            Language: await settings.GetAsync("autopublish.language", "", ct)
        ));
    }

    private static async Task<IResult> UpdateSettings(
        [FromBody] AutoPublishSettingsDto request,
        AdminSettingsService settings,
        CancellationToken ct)
    {
        await settings.SetAsync("autopublish.enabled", request.Enabled.ToString().ToLower(), ct);
        await settings.SetAsync("autopublish.booksPerDay", Math.Clamp(request.BooksPerDay, 1, 10).ToString(), ct);
        await settings.SetAsync("autopublish.hourUtc", Math.Clamp(request.HourUtc, 0, 23).ToString(), ct);
        await settings.SetAsync("autopublish.requireReview", request.RequireReview.ToString().ToLower(), ct);
        await settings.SetAsync("autopublish.language", request.Language ?? "", ct);
        return Results.Ok();
    }

    private static async Task<IResult> GetJobs(
        IAppDbContext db,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 20,
        [FromQuery] string? status = null,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = db.AutoPublishJobs
            .Include(j => j.Edition)
            .AsQueryable();

        if (status != null && Enum.TryParse<AutoPublishJobStatus>(status, true, out var s))
            query = query.Where(j => j.Status == s);

        query = query.OrderByDescending(j => j.CreatedAt);
        var total = await query.CountAsync(ct);
        var items = await query.Skip(offset).Take(limit)
            .Select(j => new AutoPublishJobListDto(
                j.Id, j.EditionId, j.Edition.Title, j.Status.ToString(),
                j.GeneratedEditionSeo, j.GeneratedAuthorSeo, j.Priority,
                j.Error, j.CreatedAt, j.StartedAt, j.FinishedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.AutoPublishJobs
            .Include(j => j.Edition)
            .FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null) return Results.NotFound();

        return Results.Ok(new AutoPublishJobDetailDto(
            job.Id, job.EditionId, job.Edition.Title, job.Status.ToString(),
            job.GeneratedEditionSeo, job.GeneratedAuthorSeo, job.Priority,
            job.Error, job.LogOutput, job.CreatedAt, job.StartedAt, job.FinishedAt
        ));
    }

    private static async Task<IResult> ApproveJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.AutoPublishJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null) return Results.NotFound();
        if (job.Status != AutoPublishJobStatus.AwaitingReview)
            return Results.BadRequest(new { error = "Job is not awaiting review" });

        job.Status = AutoPublishJobStatus.Queued;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> RejectJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.AutoPublishJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null) return Results.NotFound();
        if (job.Status != AutoPublishJobStatus.AwaitingReview)
            return Results.BadRequest(new { error = "Job is not awaiting review" });

        job.Status = AutoPublishJobStatus.Failed;
        job.Error = "Rejected by admin";
        job.FinishedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> RetryJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var job = await db.AutoPublishJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null) return Results.NotFound();
        if (job.Status is not (AutoPublishJobStatus.Failed or AutoPublishJobStatus.Cancelled))
            return Results.BadRequest(new { error = "Job is not in a terminal state" });

        job.Status = AutoPublishJobStatus.Queued;
        job.Error = null;
        job.LogOutput = null;
        job.StartedAt = null;
        job.FinishedAt = null;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> Trigger(IAppDbContext db, AdminSettingsService settings, ICurrentSite site, CancellationToken ct)
    {
        var lang = await settings.GetAsync("autopublish.language", "", ct);

        var query = db.Editions
            .Where(e => e.Status == EditionStatus.Draft)
            .Where(e => e.CoverPath != null && e.CoverPath != "")
            .Where(e => db.AutoPublishJobs
                .All(j => j.EditionId != e.Id ||
                    j.Status == AutoPublishJobStatus.Failed ||
                    j.Status == AutoPublishJobStatus.Cancelled));

        // Ensure edition has chapters
        query = query.Where(e => e.Chapters.Any());

        if (!string.IsNullOrEmpty(lang))
            query = query.Where(e => e.Language == lang);

        var edition = await query.OrderBy(e => e.CreatedAt).FirstOrDefaultAsync(ct);
        if (edition == null)
            return Results.Ok(new { error = "No candidates available" });

        var job = new AutoPublishJob
        {
            Id = Guid.NewGuid(),
            SiteId = site.Id,
            EditionId = edition.Id,
            Priority = true,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.AutoPublishJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/admin/autopublish/jobs/{job.Id}", new { id = job.Id });
    }

    private static async Task<IResult> QueueEdition(Guid editionId, IAppDbContext db, ICurrentSite site, CancellationToken ct)
    {
        var edition = await db.Editions.FirstOrDefaultAsync(e => e.Id == editionId, ct);
        if (edition == null) return Results.NotFound();
        if (edition.Status != EditionStatus.Draft)
            return Results.BadRequest(new { error = "Edition is not a draft" });

        var existing = await db.AutoPublishJobs
            .AnyAsync(j => j.EditionId == editionId &&
                j.Status != AutoPublishJobStatus.Failed &&
                j.Status != AutoPublishJobStatus.Cancelled, ct);
        if (existing)
            return Results.BadRequest(new { error = "Edition already has an active job" });

        var job = new AutoPublishJob
        {
            Id = Guid.NewGuid(),
            SiteId = site.Id,
            EditionId = editionId,
            Priority = true,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.AutoPublishJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/admin/autopublish/jobs/{job.Id}", new { id = job.Id });
    }

    private static async Task<IResult> GetCandidates(
        IAppDbContext db,
        [FromQuery] int limit = 20,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);

        var candidates = await db.Editions
            .Where(e => e.Status == EditionStatus.Draft)
            .Where(e => e.CoverPath != null && e.CoverPath != "")
            .Where(e => e.Chapters.Any())
            .Where(e => db.AutoPublishJobs
                .All(j => j.EditionId != e.Id ||
                    j.Status == AutoPublishJobStatus.Failed ||
                    j.Status == AutoPublishJobStatus.Cancelled))
            .OrderBy(e => e.CreatedAt)
            .Take(limit)
            .Select(e => new CandidateEditionDto(
                e.Id, e.Title, e.Language,
                e.Chapters.Count(),
                e.Description != null && e.Description != "",
                e.SeoRelevanceText != null && e.SeoRelevanceText != "",
                e.SeoThemesJson != null && e.SeoThemesJson != "",
                e.SeoFaqsJson != null && e.SeoFaqsJson != "",
                e.CreatedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(candidates);
    }

    /// <summary>
    /// AI-042 — runs the in-process content crew over an Edition to generate its two SEO prose fields
    /// (<c>Description</c> + <c>SeoRelevanceText</c>). Loads the same source material the legacy
    /// <c>seo-generate.sh</c> uses (title, author(s), language, first-chapter excerpt), runs the crew once per
    /// field (own runId, own cost cap, own persisted agent_run), and applies a fail-closed review gate: only if
    /// BOTH fields pass cleanly does it write them and set <c>SeoSource = Auto</c>. The Edition stays Draft
    /// either way — publishing remains the existing separate flow. No auto-publish, ever.
    /// </summary>
    private static async Task<IResult> CrewGenerate(
        Guid editionId,
        HttpContext httpContext,
        IAppDbContext db,
        AutoPublishCrew crew,
        CancellationToken ct)
    {
        var adminId = httpContext.GetAdminUserId();

        var edition = await db.Editions
            .Include(e => e.EditionAuthors)
                .ThenInclude(ea => ea.Author)
            .FirstOrDefaultAsync(e => e.Id == editionId, ct);
        if (edition == null) return Results.NotFound();

        // First-chapter excerpt — mirror seo-generate.sh: LEFT(plain_text, 1000) of the lowest chapter_number.
        var excerpt = await db.Chapters
            .Where(c => c.EditionId == editionId)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => c.PlainText)
            .FirstOrDefaultAsync(ct);

        var authors = string.Join(", ", edition.EditionAuthors
            .Select(ea => ea.Author?.Name)
            .Where(n => !string.IsNullOrWhiteSpace(n)));
        var lang = edition.Language;

        var sourceMaterial = BuildSourceMaterial(edition.Title, authors, lang, excerpt);

        // One crew per field — separate runIds so AI-045's transcript UI can fetch each independently.
        var descCtx = new AgentContext(adminId, editionId, Guid.NewGuid(), httpContext.RequestServices);
        var descResult = await crew.RunFieldAsync(AutoPublishBriefs.Description(lang), sourceMaterial, descCtx, ct);

        var relCtx = new AgentContext(adminId, editionId, Guid.NewGuid(), httpContext.RequestServices);
        var relResult = await crew.RunFieldAsync(AutoPublishBriefs.Relevance(lang), sourceMaterial, relCtx, ct);

        var runIds = new[] { descResult.RunId, relResult.RunId };
        var fields = new[]
        {
            FieldSummary("description", descResult),
            FieldSummary("relevance", relResult),
        };

        // Manual-source protection (AI-042 P2): a Manual edition with hand-written prose in either targeted field
        // is never overwritten by the crew — same contract legacy SEO backfill honors (SeoCoverageAnalyzer). The
        // crew transcripts are still persisted (audit), only the write-back is blocked.
        if (IsManualProtected(edition.SeoSource, edition.Description, edition.SeoRelevanceText))
            return Results.Ok(new CrewGenerateResponse(true, runIds, fields, ManualProtected: true));

        // Fail-closed gate: if EITHER field needs review, write NOTHING — the admin inspects both transcripts.
        var needsReview = descResult.NeedsReview || relResult.NeedsReview;
        if (needsReview)
            return Results.Ok(new CrewGenerateResponse(true, runIds, fields));

        // Both clean → apply the prose and mark provenance Auto. Edition stays Draft regardless.
        edition.Description = descResult.EditedText;
        edition.SeoRelevanceText = relResult.EditedText;
        edition.SeoSource = SeoSource.Auto;
        edition.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new CrewGenerateResponse(false, runIds, fields));
    }

    /// <summary>
    /// The manual-source write-block decision (AI-042 P2), pure for unit testing. Returns true when the edition is
    /// <see cref="SeoSource.Manual"/> AND either targeted prose field already holds hand-written content — in which
    /// case the crew must NOT overwrite it. Empty Manual fields are still fair game for first-time generation.
    /// </summary>
    internal static bool IsManualProtected(SeoSource source, string? description, string? relevanceText) =>
        source == SeoSource.Manual &&
        (!string.IsNullOrWhiteSpace(description) || !string.IsNullOrWhiteSpace(relevanceText));

    /// <summary>The source block the crew reasons from — same fields seo-generate.sh feeds Claude.</summary>
    private static string BuildSourceMaterial(string title, string author, string lang, string? excerpt) =>
        $"""
         Book: {title}
         Author: {(string.IsNullOrWhiteSpace(author) ? "Unknown" : author)}
         Language: {LanguageNames.ToEnglishName(lang)}
         First chapter excerpt: {Excerpt(excerpt)}
         """;

    private static string Excerpt(string? plainText)
    {
        if (string.IsNullOrWhiteSpace(plainText)) return "(none)";
        return plainText.Length <= 1000 ? plainText : plainText[..1000];
    }

    private static CrewFieldSummary FieldSummary(string field, AutoPublishFieldResult r) =>
        new(
            field,
            r.RunId,
            r.Status,
            r.NeedsReview,
            r.EditedText?.Length ?? 0,
            r.Critique is { } c
                ? new CrewCritiqueSummary(c.FactualAccuracy, c.Tone, c.Length, c.BannedPhrases, c.ParseFailed,
                    c.Issues.Count(i => i.Severity == "blocker"))
                : null);
}

public record CrewGenerateResponse(
    bool NeedsReview,
    IReadOnlyList<Guid> RunIds,
    IReadOnlyList<CrewFieldSummary> Fields,
    bool ManualProtected = false);

public record CrewFieldSummary(
    string Field,
    Guid RunId,
    string Status,
    bool NeedsReview,
    int CharLength,
    CrewCritiqueSummary? Critique);

public record CrewCritiqueSummary(
    int FactualAccuracy,
    int Tone,
    int Length,
    int BannedPhrases,
    bool ParseFailed,
    int BlockerCount);

public record AutoPublishSettingsDto(
    bool Enabled, int BooksPerDay, int HourUtc, bool RequireReview, string Language);

public record AutoPublishJobListDto(
    Guid Id, Guid EditionId, string EditionTitle, string Status,
    bool GeneratedEditionSeo, bool GeneratedAuthorSeo, bool Priority,
    string? Error, DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt);

public record AutoPublishJobDetailDto(
    Guid Id, Guid EditionId, string EditionTitle, string Status,
    bool GeneratedEditionSeo, bool GeneratedAuthorSeo, bool Priority,
    string? Error, string? LogOutput,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt);

public record CandidateEditionDto(
    Guid Id, string Title, string? Language, int ChapterCount,
    bool HasDescription, bool HasRelevance, bool HasThemes, bool HasFaqs,
    DateTimeOffset CreatedAt);
