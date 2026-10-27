using System.Text.Json;
using Api.Middleware;
using Application.Agents;
using Application.Common;
using Application.Common.Interfaces;
using Application.Seo;
using Domain.Entities;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Core;

namespace Api.Endpoints;

/// <summary>
/// Admin panel endpoints for SEO backfill automation:
///   /admin/seo/templates    — CRUD + preview
///   /admin/seo/jobs         — list / approve / revert / retry
///   /admin/seo/coverage     — coverage stats
///   /admin/seo/gaps         — gap lookup + bulk queue
///   /admin/seo/queue        — single-entity queue
///   /admin/seo/settings     — singleton settings GET/PUT
/// </summary>
public static class AdminSeoBackfillEndpoints
{
    public static void MapAdminSeoBackfillEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin/seo").WithTags("SEO Backfill");

        // Templates
        group.MapGet("/templates", ListTemplates);
        group.MapGet("/templates/{id:guid}", GetTemplate);
        group.MapPost("/templates", CreateTemplate);
        group.MapPut("/templates/{id:guid}", UpdateTemplate);
        group.MapDelete("/templates/{id:guid}", DeactivateTemplate);
        group.MapPost("/templates/{id:guid}/preview", PreviewTemplate);

        // Jobs
        group.MapGet("/jobs", ListJobs);
        group.MapGet("/jobs/{id:guid}", GetJob);
        group.MapPost("/jobs/{id:guid}/approve", ApproveJob);
        group.MapPost("/jobs/{id:guid}/revert", RevertJob);
        group.MapPost("/jobs/{id:guid}/retry", RetryJob);

        // Coverage + gaps
        group.MapGet("/coverage", GetCoverage);
        group.MapGet("/gaps", GetGaps);

        // Queue
        group.MapPost("/queue", QueueEntity);

        // Settings
        group.MapGet("/settings", GetSettings);
        group.MapPut("/settings", UpdateSettings);

        // AI-043: in-process crew path — runs the AI-041 specialists over ILlmService to generate ONE SEO prose
        // field (edition→description, author→bio), routed through the SeoBackfillJob apply path so revert/trust/
        // SSG keep working. Behind the same /admin/* auth group; rate-limited. Legacy poller stays the default.
        group.MapPost("/{entityType}/{entityId:guid}/crew-generate", CrewGenerate)
            .RequireRateLimiting("seo.crew");
    }

    // ── Templates ──

    private static async Task<IResult> ListTemplates(
        IAppDbContext db,
        [FromQuery] string? entityType,
        [FromQuery] string? fieldType,
        [FromQuery] string? language,
        [FromQuery] bool onlyActive = true,
        CancellationToken ct = default)
    {
        var q = db.SeoTemplates.AsNoTracking().AsQueryable();
        if (onlyActive) q = q.Where(t => t.IsActive);
        if (!string.IsNullOrWhiteSpace(entityType) && Enum.TryParse<SeoEntityType>(entityType, true, out var et))
            q = q.Where(t => t.EntityType == et);
        if (!string.IsNullOrWhiteSpace(fieldType) && Enum.TryParse<SeoFieldType>(fieldType, true, out var ft))
            q = q.Where(t => t.FieldType == ft);
        if (!string.IsNullOrWhiteSpace(language))
            q = q.Where(t => t.LanguageCode == language);

        var items = await q
            .OrderBy(t => t.EntityType).ThenBy(t => t.FieldType).ThenBy(t => t.LanguageCode)
            .Select(t => new
            {
                t.Id,
                EntityType = t.EntityType.ToString(),
                FieldType = t.FieldType.ToString(),
                t.LanguageCode,
                t.Name,
                t.Description,
                t.Model,
                t.MaxTokens,
                t.Temperature,
                TrustLevel = t.TrustLevel.ToString(),
                t.Version,
                t.IsActive,
                t.UpdatedAt
            })
            .ToListAsync(ct);
        return Results.Ok(items);
    }

    private static async Task<IResult> GetTemplate(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var t = await db.SeoTemplates.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        return t is null ? Results.NotFound() : Results.Ok(t);
    }

    public record UpsertTemplateRequest(
        string EntityType,
        string FieldType,
        string LanguageCode,
        string Name,
        string? Description,
        string PromptTemplate,
        string OutputSchema,
        string? Model,
        int? MaxTokens,
        double? Temperature,
        string? TrustLevel);

    private static async Task<IResult> CreateTemplate(
        [FromBody] UpsertTemplateRequest req, IAppDbContext db, CancellationToken ct)
    {
        if (InvalidField(req, create: true) is { } invalid) return Results.BadRequest(new { error = invalid });
        if (!Enum.TryParse<SeoEntityType>(req.EntityType, true, out var et))
            return Results.BadRequest(new { error = "Unknown entityType" });
        if (!Enum.TryParse<SeoFieldType>(req.FieldType, true, out var ft))
            return Results.BadRequest(new { error = "Unknown fieldType" });
        // Validate schema is parseable
        try { using var _ = JsonDocument.Parse(req.OutputSchema); }
        catch (JsonException ex) { return Results.BadRequest(new { error = $"Invalid outputSchema JSON: {ex.Message}" }); }

        var trust = SeoTrustLevel.Review;
        if (!string.IsNullOrWhiteSpace(req.TrustLevel) && Enum.TryParse<SeoTrustLevel>(req.TrustLevel, true, out var parsed)) trust = parsed;

        var language = req.LanguageCode.Trim().ToLowerInvariant();
        // One active template per key (ix_seo_templates_entity_type_field_type_language_code, #939): a second goes through Edit.
        if (await db.SeoTemplates.ActiveForKey(et, ft, language).AnyAsync(ct))
            return ActiveTemplateConflict();

        var tpl = new SeoTemplate
        {
            Id = Guid.NewGuid(),
            EntityType = et,
            FieldType = ft,
            LanguageCode = language,
            Name = req.Name.Trim(),
            Description = req.Description?.Trim(),
            PromptTemplate = req.PromptTemplate,
            OutputSchema = req.OutputSchema,
            Model = string.IsNullOrWhiteSpace(req.Model) ? "claude-sonnet-4-6" : req.Model,
            MaxTokens = req.MaxTokens ?? 4096,
            Temperature = req.Temperature ?? 0.7,
            TrustLevel = trust,
            Version = 1,
            IsActive = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.SeoTemplates.Add(tpl);
        // A concurrent create can pass the check above too; once 0012 is in, its index refuses the second.
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation()) { return ActiveTemplateConflict(); }
        return Results.Ok(new { tpl.Id, tpl.Version });
    }

    private static async Task<IResult> UpdateTemplate(
        Guid id, [FromBody] UpsertTemplateRequest req, IAppDbContext db, CancellationToken ct)
    {
        if (InvalidField(req, create: false) is { } invalid) return Results.BadRequest(new { error = invalid });
        // "Edit" creates a new Version — old one deactivated.
        var current = await db.SeoTemplates.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (current is null) return Results.NotFound();

        try { using var _ = JsonDocument.Parse(req.OutputSchema); }
        catch (JsonException ex) { return Results.BadRequest(new { error = $"Invalid outputSchema JSON: {ex.Message}" }); }

        // Deactivate the key's active version, then insert the new one. Two statements in order:
        // the one-active unique index cannot be deferred, and one SaveChanges does not fix the order.
        await using var tx = await db.BeginTransactionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        await db.SeoTemplates
            .ActiveForKey(current.EntityType, current.FieldType, current.LanguageCode)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.IsActive, false).SetProperty(t => t.UpdatedAt, now), ct);

        // Editing an older version must not reuse a number the key already has.
        var lastVersion = await db.SeoTemplates
            .ForKey(current.EntityType, current.FieldType, current.LanguageCode)
            .MaxAsync(t => t.Version, ct);

        var trust = current.TrustLevel;
        if (!string.IsNullOrWhiteSpace(req.TrustLevel) && Enum.TryParse<SeoTrustLevel>(req.TrustLevel, true, out var parsed)) trust = parsed;

        var next = new SeoTemplate
        {
            Id = Guid.NewGuid(),
            EntityType = current.EntityType,
            FieldType = current.FieldType,
            LanguageCode = current.LanguageCode,
            Name = req.Name.Trim(),
            Description = req.Description?.Trim(),
            PromptTemplate = req.PromptTemplate,
            OutputSchema = req.OutputSchema,
            Model = string.IsNullOrWhiteSpace(req.Model) ? current.Model : req.Model,
            MaxTokens = req.MaxTokens ?? current.MaxTokens,
            Temperature = req.Temperature ?? current.Temperature,
            TrustLevel = trust,
            Version = lastVersion + 1,
            IsActive = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.SeoTemplates.Add(next);
        // A concurrent edit of the same key inserts its own active row; once 0012 is in, its index
        // refuses the second.
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation()) { return ActiveTemplateConflict(); }
        await tx.CommitAsync(ct);
        return Results.Ok(new { next.Id, next.Version });
    }

    // The request record's non-nullable strings arrive null when the JSON leaves them out, and a
    // value over its column's length (AppDbContext.Seo.cs) fails the insert: both were 500s.
    // An edit keeps its template's key, so the key fields are checked on create only.
    private static string? InvalidField(UpsertTemplateRequest req, bool create)
    {
        if (create && string.IsNullOrWhiteSpace(req.EntityType)) return "entityType is required";
        if (create && string.IsNullOrWhiteSpace(req.FieldType)) return "fieldType is required";
        if (create && string.IsNullOrWhiteSpace(req.LanguageCode)) return "languageCode is required";
        if (string.IsNullOrWhiteSpace(req.Name)) return "name is required";
        if (string.IsNullOrWhiteSpace(req.PromptTemplate)) return "promptTemplate is required";
        if (string.IsNullOrWhiteSpace(req.OutputSchema)) return "outputSchema is required";
        if (create && req.LanguageCode.Trim().Length > 8) return "languageCode is longer than 8";
        if (req.Name.Trim().Length > 200) return "name is longer than 200";
        if (req.Description?.Trim().Length > 500) return "description is longer than 500";
        if (req.Model?.Length > 100) return "model is longer than 100";
        return null;
    }

    private static IResult ActiveTemplateConflict() =>
        Results.Conflict(new { error = "The key already has an active template; edit it instead" });

    private static async Task<IResult> DeactivateTemplate(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var t = await db.SeoTemplates.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (t is null) return Results.NotFound();
        t.IsActive = false;
        t.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    public record PreviewTemplateRequest(Guid EntityId);

    private static async Task<IResult> PreviewTemplate(
        Guid id,
        [FromBody] PreviewTemplateRequest req,
        IAppDbContext db,
        SeoContextBuilder contextBuilder,
        CancellationToken ct)
    {
        var tpl = await db.SeoTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (tpl is null) return Results.NotFound();

        var values = await contextBuilder.BuildAsync(tpl.EntityType, req.EntityId, ct);
        var rendered = SeoTemplateRenderer.Render(tpl.PromptTemplate, values);
        var missing = SeoTemplateRenderer.FindMissingPlaceholders(tpl.PromptTemplate, values);
        return Results.Ok(new { rendered, missingPlaceholders = missing, values });
    }

    // ── Jobs ──

    private static async Task<IResult> ListJobs(
        IAppDbContext db,
        [FromQuery] string? status,
        [FromQuery] string? entityType,
        [FromQuery] int offset = 0,
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 200);
        offset = Math.Max(0, offset);

        var q = db.SeoBackfillJobs.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(status) && Enum.TryParse<SeoJobStatus>(status, true, out var s))
            q = q.Where(j => j.Status == s);
        if (!string.IsNullOrWhiteSpace(entityType) && Enum.TryParse<SeoEntityType>(entityType, true, out var et))
            q = q.Where(j => j.EntityType == et);

        q = q.OrderByDescending(j => j.CreatedAt);
        var total = await q.CountAsync(ct);
        var items = await q.Skip(offset).Take(limit)
            .Select(j => new
            {
                j.Id,
                EntityType = j.EntityType.ToString(),
                j.EntityId,
                j.TargetFields,
                Status = j.Status.ToString(),
                j.Error,
                j.CreatedAt,
                j.StartedAt,
                j.CompletedAt,
                j.TriggeredBy,
                j.RequiresReview
            })
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var j = await db.SeoBackfillJobs.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (j is null) return Results.NotFound();
        return Results.Ok(new
        {
            j.Id,
            EntityType = j.EntityType.ToString(),
            j.EntityId,
            j.TargetFields,
            j.TemplateIds,
            j.TemplateVersions,
            Status = j.Status.ToString(),
            j.InputSnapshot,
            j.RenderedPrompts,
            j.RawOutputs,
            j.GeneratedContent,
            j.BeforeSnapshot,
            j.AfterSnapshot,
            j.Error,
            j.CreatedAt,
            j.StartedAt,
            j.CompletedAt,
            j.TriggeredBy,
            j.RequiresReview,
            j.ApprovedByUserId,
            j.ApprovedAt
        });
    }

    private static async Task<IResult> ApproveJob(
        Guid id,
        HttpContext ctx,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        var adminId = TryGetAdminUserId(ctx);
        try
        {
            await processor.ApproveAsync(id, adminId, ct);
            return Results.Ok();
        }
        catch (InvalidOperationException ex) { return Results.BadRequest(new { error = ex.Message }); }
    }

    private static async Task<IResult> RevertJob(Guid id, SeoJobProcessor processor, CancellationToken ct)
    {
        try
        {
            await processor.RevertAsync(id, ct);
            return Results.Ok();
        }
        catch (InvalidOperationException ex) { return Results.BadRequest(new { error = ex.Message }); }
    }

    private static async Task<IResult> RetryJob(Guid id, IAppDbContext db, CancellationToken ct)
    {
        var j = await db.SeoBackfillJobs.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (j is null) return Results.NotFound();
        if (j.Status is not (SeoJobStatus.Failed or SeoJobStatus.Reverted))
            return Results.BadRequest(new { error = $"Cannot retry job in status {j.Status}" });
        j.Status = SeoJobStatus.Queued;
        j.Error = null;
        j.AttemptCount = 0;
        j.StartedAt = null;
        j.CompletedAt = null;
        j.RawOutputs = null;
        j.GeneratedContent = null;
        j.AfterSnapshot = null;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    // ── Coverage ──

    private static async Task<IResult> GetCoverage(SeoCoverageAnalyzer analyzer, CancellationToken ct)
    {
        var stats = await analyzer.GetCoverageAsync(ct);
        return Results.Ok(stats);
    }

    private static async Task<IResult> GetGaps(
        SeoCoverageAnalyzer analyzer,
        [FromQuery] string entityType = "Edition",
        [FromQuery] string? language = null,
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 500);
        var list = entityType.ToLowerInvariant() switch
        {
            "author" => await analyzer.GetAuthorGapsAsync(language, limit, ct),
            "genre" => await analyzer.GetGenreGapsAsync(limit, ct),
            _ => await analyzer.GetEditionGapsAsync(language, limit, ct),
        };
        return Results.Ok(list);
    }

    // ── Queue ──

    public record QueueRequest(string EntityType, Guid EntityId, List<string> Fields, string Language = "en", bool RequireReview = true);

    private static async Task<IResult> QueueEntity(
        [FromBody] QueueRequest req,
        HttpContext ctx,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        if (!Enum.TryParse<SeoEntityType>(req.EntityType, true, out var et))
            return Results.BadRequest(new { error = "Unknown entityType" });
        var fields = new List<SeoFieldType>();
        foreach (var f in req.Fields)
        {
            if (!Enum.TryParse<SeoFieldType>(f, true, out var ft))
                return Results.BadRequest(new { error = $"Unknown field '{f}'" });
            fields.Add(ft);
        }
        if (fields.Count == 0) return Results.BadRequest(new { error = "Fields required" });

        var triggeredBy = ctx.User?.Identity?.Name ?? "admin:unknown";
        try
        {
            var id = await processor.EnqueueAsync(et, req.EntityId, fields, req.Language, req.RequireReview, triggeredBy, ct);
            return Results.Ok(new { jobId = id });
        }
        catch (InvalidOperationException ex) { return Results.BadRequest(new { error = ex.Message }); }
    }

    // ── Settings ──

    private static async Task<IResult> GetSettings(IAppDbContext db, CancellationToken ct)
    {
        var s = await db.SeoBackfillSettings.FirstOrDefaultAsync(x => x.Id == SeoBackfillSettings.FixedId, ct);
        if (s is null) return Results.Ok(new { enabled = false, jobsPerRun = 5, intervalSeconds = 60 });
        return Results.Ok(new
        {
            s.Enabled,
            s.JobsPerRun,
            s.IntervalSeconds
        });
    }

    public record UpdateSettingsRequest(
        bool? Enabled,
        int? JobsPerRun,
        int? IntervalSeconds);

    private static async Task<IResult> UpdateSettings(
        [FromBody] UpdateSettingsRequest req, IAppDbContext db, CancellationToken ct)
    {
        var s = await db.SeoBackfillSettings.FirstOrDefaultAsync(x => x.Id == SeoBackfillSettings.FixedId, ct);
        if (s is null)
        {
            s = new SeoBackfillSettings { Id = SeoBackfillSettings.FixedId };
            db.SeoBackfillSettings.Add(s);
        }
        if (req.Enabled.HasValue) s.Enabled = req.Enabled.Value;
        if (req.JobsPerRun.HasValue) s.JobsPerRun = Math.Clamp(req.JobsPerRun.Value, 1, 50);
        if (req.IntervalSeconds.HasValue) s.IntervalSeconds = Math.Clamp(req.IntervalSeconds.Value, 10, 3600);
        s.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static Guid TryGetAdminUserId(HttpContext ctx)
    {
        var sub = ctx.User?.FindFirst("sub")?.Value ?? ctx.User?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(sub, out var id) ? id : Guid.Empty;
    }

    // ── Crew generate (AI-043) ──

    /// <summary>
    /// Runs the in-process SEO crew over one entity to generate its single in-scope prose field
    /// (edition→Description, author→Bio). Loads the entity context (404 if missing), sanitizes EVERY value
    /// against prompt-injection, flattens it to source material, runs the 4-stage crew (own runId, own cost cap,
    /// own persisted <c>crew.seo</c> agent_run), then routes the result through the existing SeoBackfillJob apply
    /// path — so revert / trust-gate / SSG behave identically to the legacy poller. The Edition/Author is only
    /// written when the crew passes cleanly AND the job's effective trust is Auto.
    /// </summary>
    private static async Task<IResult> CrewGenerate(
        string entityType,
        Guid entityId,
        HttpContext httpContext,
        IAppDbContext db,
        SeoContextBuilder contextBuilder,
        SeoCrew crew,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        // v1: prose-only, edition/description + author/bio.
        if (!Enum.TryParse<SeoEntityType>(entityType, true, out var et)
            || et is not (SeoEntityType.Edition or SeoEntityType.Author))
            return Results.BadRequest(new { error = "entityType must be 'edition' or 'author'" });

        var (fieldType, fieldName) = et == SeoEntityType.Edition
            ? (SeoFieldType.Description, "description")
            : (SeoFieldType.Bio, "bio");

        // Resolve entity context (BuildAsync throws InvalidOperationException if the entity is missing → 404).
        Dictionary<string, string?> values;
        try
        {
            values = await contextBuilder.BuildAsync(et, entityId, ct);
        }
        catch (InvalidOperationException)
        {
            return Results.NotFound();
        }

        // Sanitize EVERY entity value before it reaches the prose specialists (prompt-injection defense), then
        // flatten to a single source block. The lang comes from the (sanitized) context.
        var lang = SeoPromptSanitizer.Sanitize(values.GetValueOrDefault("language") ?? "en");
        if (string.IsNullOrWhiteSpace(lang)) lang = "en";
        var sourceMaterial = string.Join("\n", values
            .Where(kv => !string.IsNullOrWhiteSpace(kv.Value))
            .Select(kv => $"{kv.Key}: {SeoPromptSanitizer.Sanitize(kv.Value)}"));

        var brief = SeoBriefs.For(entityType.ToLowerInvariant(), fieldName, lang);

        // P2 — source-material floor. An Edition with no usable chapters yields an almost-empty excerpt → the crew
        // would hallucinate confidently. We still RUN the crew (transcript persists) but force NeedsReview on apply.
        var sourceInsufficient = SeoJobProcessor.IsSourceMaterialInsufficient(sourceMaterial);

        var adminId = httpContext.GetAdminUserId();
        // P3 — AgentContext.EditionId is the EDITION slot only (persisted to agent_run.edition_id, which has no FK).
        // For non-edition entities (author) pass null so we never store an author id in an edition-named column; the
        // run is cross-linked to the entity via the SeoBackfillJob (entityType+entityId) and the runId on the job.
        var slotEditionId = et == SeoEntityType.Edition ? entityId : (Guid?)null;
        var crewCtx = new AgentContext(adminId, slotEditionId, Guid.NewGuid(), httpContext.RequestServices);

        // Route through the SeoBackfillJob apply path so revert/trust/audit/SSG all keep working. EnqueueAsync
        // resolves the active template ids/versions (→ TrustLevel) and freezes them on the job.
        var triggeredBy = httpContext.User?.Identity?.Name ?? "admin:crew";
        Guid jobId;
        try
        {
            jobId = await processor.EnqueueAsync(
                et, entityId, [fieldType], lang, requireReview: false, triggeredBy, ct);
        }
        catch (InvalidOperationException ex)
        {
            // No active template for this field/lang, or a dedup conflict (existing queued/running job).
            return Results.BadRequest(new { error = ex.Message });
        }

        // P1#1 — transition THIS job Queued→Running before GetContextAsync (which asserts Running). ClaimNextAsync
        // would claim an arbitrary job, so we use the targeted MarkRunningAsync. Wrap crew+apply so any mid-run
        // failure marks the job Failed (not left Running/Queued) — otherwise it wedges the entity via the dedup guard.
        FieldResult result;
        string applyStatus;
        try
        {
            if (!await processor.MarkRunningAsync(jobId, ct))
                throw new InvalidOperationException($"Job {jobId} could not transition Queued→Running");

            // GetContextAsync writes the Before snapshot, mirroring the legacy flow before apply (so revert has a
            // baseline even though the crew, not Claude, produced text).
            await processor.GetContextAsync(jobId, ct);

            result = await crew.RunFieldAsync(brief, sourceMaterial, crewCtx, ct);

            var editedText = new Dictionary<string, string>();
            if (!result.NeedsReview && !string.IsNullOrWhiteSpace(result.EditedText))
                editedText[fieldType.ToString()] = result.EditedText!;

            applyStatus = await processor.ApplyCrewResultAsync(
                jobId, editedText, result.NeedsReview, sourceInsufficient, ct);
        }
        catch (Exception ex)
        {
            // Crew threw or a step failed mid-way: mark the job Failed so the entity isn't wedged Running/Queued.
            await processor.FailAsync(jobId, $"crew-generate failed: {ex.Message}", ct);
            return Results.Problem($"crew-generate failed: {ex.Message}");
        }

        var critique = result.Critique is { } c
            ? new SeoCrewCritiqueSummary(c.FactualAccuracy, c.Tone, c.Length, c.BannedPhrases, c.ParseFailed,
                c.Issues.Count(i => i.Severity == "blocker"))
            : null;

        return Results.Ok(new SeoCrewGenerateResponse(
            entityType.ToLowerInvariant(),
            fieldName,
            result.RunId,
            jobId,
            result.Status,
            applyStatus,
            result.NeedsReview,
            Applied: applyStatus == "success",
            result.EditedText?.Length ?? 0,
            critique));
    }
}

public record SeoCrewGenerateResponse(
    string EntityType,
    string Field,
    Guid RunId,
    Guid JobId,
    string CrewStatus,
    string ApplyStatus,
    bool NeedsReview,
    bool Applied,
    int CharLength,
    SeoCrewCritiqueSummary? Critique);

public record SeoCrewCritiqueSummary(
    int FactualAccuracy,
    int Tone,
    int Length,
    int BannedPhrases,
    bool ParseFailed,
    int BlockerCount);
