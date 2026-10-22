using Domain.Enums;

namespace Domain.Entities;

/// <summary>
/// One run of SEO generation for a single entity across one or more target fields.
/// Immutable audit record: snapshots before/after state, frozen template versions, raw Claude output.
/// </summary>
public class SeoBackfillJob
{
    public Guid Id { get; set; }

    public SeoEntityType EntityType { get; set; }
    public Guid EntityId { get; set; }

    /// <summary>Fields this run generated (matches TemplateIds/TemplateVersions element-wise).</summary>
    public required string[] TargetFields { get; set; }

    /// <summary>Template IDs used for each target field. Frozen reference.</summary>
    public required Guid[] TemplateIds { get; set; }

    /// <summary>Template versions at the time the job was queued. Enables immutable replay even if template is edited.</summary>
    public required int[] TemplateVersions { get; set; }

    public SeoJobStatus Status { get; set; } = SeoJobStatus.Queued;

    /// <summary>Entity data used to render prompts (JSON). Kept for debug + reproducibility.</summary>
    public string? InputSnapshot { get; set; }

    /// <summary>{ field: prompt_text } rendered prompts, per field (JSON). Debug only.</summary>
    public string? RenderedPrompts { get; set; }

    /// <summary>{ field: raw_claude_output } (JSON).</summary>
    public string? RawOutputs { get; set; }

    /// <summary>Parsed + validated content per field, ready to apply (JSON).</summary>
    public string? GeneratedContent { get; set; }

    /// <summary>Entity state before apply — enables revert (JSON).</summary>
    public string? BeforeSnapshot { get; set; }

    /// <summary>Entity state after apply (JSON).</summary>
    public string? AfterSnapshot { get; set; }

    public string? Error { get; set; }

    /// <summary>Times this job was claimed. A Running job left by a dead poller is re-queued until <c>SeoJobProcessor.MaxAttempts</c>.</summary>
    public int AttemptCount { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>Who triggered this: "admin:email", "cron", "bulk".</summary>
    public string TriggeredBy { get; set; } = "admin";

    public bool RequiresReview { get; set; } = true;

    public Guid? ApprovedByUserId { get; set; }
    public DateTimeOffset? ApprovedAt { get; set; }
}
