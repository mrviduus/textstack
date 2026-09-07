using Domain.Enums;

namespace Domain.Entities;

public class UserBook
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public required string Title { get; set; }
    public required string Slug { get; set; }
    public required string Language { get; set; }
    public string? Author { get; set; }
    public string? Description { get; set; }
    public string? CoverPath { get; set; }
    public string? Genre { get; set; }
    public int? PublishedYear { get; set; }
    public int? TotalWordCount { get; set; }
    public string? TocJson { get; set; }
    public UserBookStatus Status { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    // Reading progress
    public string? ProgressChapterSlug { get; set; }
    public string? ProgressLocator { get; set; }

    /// <summary>
    /// The logical reading position. Same contract, same invariant and same
    /// reasons as <see cref="ReadingProgress.PositionJson"/> — see there.
    /// </summary>
    public string? ProgressPositionJson { get; set; }

    /// <summary>
    /// Progress across the WHOLE BOOK, 0..1 — not within the current chapter.
    /// Canonicalised in PR #412 after the library card and the Continue-reading
    /// shelf disagreed about the same book; the shelf was re-adding prior-chapter
    /// words to a value that already counted them. Same unit as
    /// <see cref="ReadingProgress.Percent"/>.
    /// </summary>
    public double? ProgressPercent { get; set; }

    public DateTimeOffset? ProgressUpdatedAt { get; set; }

    /// <summary>Set once <see cref="ProgressPercent"/> crosses 0.99, or by an
    /// explicit mark-as-finished. The presence of this is the answer to "is it
    /// finished?" — not a threshold comparison at the call site.</summary>
    public DateTimeOffset? CompletedAt { get; set; }

    // Takedown (DMCA / admin action) — soft-blocks access while keeping record for audit
    public DateTimeOffset? TakedownAt { get; set; }
    public string? TakedownReason { get; set; }

    // "Send to TextStack" web clip (private only — never enters the public Work/Edition/SSG path).
    public string? SourceUrl { get; set; }   // original article URL
    public bool IsClip { get; set; }         // true => Read later shelf
    public bool IsRead { get; set; }         // manual or auto-set when progress completes
    public DateTimeOffset? ReadAt { get; set; }

    // Editable metadata (slice 11)
    // 'auto' = LLM/import-derived, 'manual' = user-edited (protect from auto-overwrite)
    public string SeoSource { get; set; } = "auto";
    // JSONB array of prior metadata snapshots (capped at 5 server-side)
    public string? MetadataHistoryJson { get; set; }

    // Enrichment agent provenance (AI-Agent-1). The agent cross-checks the LLM guess against
    // Open Library and writes a calibrated overall confidence (0–1) + per-field provenance
    // ({field: {value, source, confidence}}). SeoSource above doubles as the source guard:
    // 'manual' rows are never overwritten; the agent writes 'auto'.
    public double? MetadataConfidence { get; set; }
    public string? MetadataProvenanceJson { get; set; }

    // Visible enrichment lifecycle (enrichment-reliability). NotStarted = pre-feature backlog (badge
    // hidden). Pending set on ingestion-Ready + on re-enrich; the worker atomically claims → Running
    // (stamping MetadataEnrichmentAt for dead-process/stale detection) → Completed (even if nothing
    // was filled) or Failed. Separate from Status/SeoSource (extraction / user-edit guard).
    public MetadataEnrichmentStatus MetadataEnrichmentStatus { get; set; } = MetadataEnrichmentStatus.NotStarted;
    public DateTimeOffset? MetadataEnrichmentAt { get; set; }

    // User-defined tags (slice 12) — Postgres text[] with GIN index, max 20 enforced server-side
    public string[] Tags { get; set; } = [];

    // AI-suggested tags pending user approval (slice 17). Cleared on accept or dismiss.
    public string[] SuggestedTags { get; set; } = [];
    public DateTimeOffset? SuggestedTagsAt { get; set; }

    // On-demand RAG index state (Phase 2 "Ask this book" for user uploads). Mirrors Edition's fields.
    // A user trigger claims (NotIndexed/Failed → Indexing) → chunks → the embedding worker flips Ready.
    public RagIndexStatus RagStatus { get; set; } = RagIndexStatus.NotIndexed;
    public int RagChunkCount { get; set; }
    public int RagEmbeddedCount { get; set; }
    public DateTimeOffset? RagIndexedAt { get; set; }
    public string? RagError { get; set; }

    // Stamped by the worker's atomic indexing claim (Indexing + chunk_count=0 + started_at IS NULL →
    // now()). Mirrors MetadataEnrichmentAt: it is the dead-process/stale detector — a row still
    // Indexing with started_at older than the stale window means the process that claimed it died
    // mid-chunk, so the sweep flips it to a terminal Failed (no forever-Indexing dead end).
    public DateTimeOffset? RagIndexingStartedAt { get; set; }

    public User User { get; set; } = null!;
    public ICollection<UserChapter> Chapters { get; set; } = [];
    public ICollection<UserBookFile> BookFiles { get; set; } = [];
    public ICollection<UserIngestionJob> IngestionJobs { get; set; } = [];
}
