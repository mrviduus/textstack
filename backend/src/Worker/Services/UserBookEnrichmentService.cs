using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// The single seam that runs a user book's metadata enrichment with a visible, terminal status. Its one
/// consumer is <see cref="MetadataEnrichmentWorker"/> (ADR-022; ingestion's inline kick was removed); the
/// atomic claim (Pending → Running) still keeps a second trigger harmless. The enrichment itself is best-effort:
/// the status always reaches a terminal state (Completed even when nothing was filled, or Failed on error)
/// — that is what kills the "forever-enriching" badge.
/// </summary>
public class UserBookEnrichmentService(
    IDbContextFactory<AppDbContext> dbFactory,
    IBookMetadataGenerator metadataGenerator,
    ILogger<UserBookEnrichmentService> logger)
{
    public async Task EnrichAsync(Guid bookId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);

        // Atomic claim: only the caller that flips Pending → Running proceeds; a second trigger sees
        // rowcount 0 and returns. now() also stamps stale detection.
        var claimed = await db.UserBooks
            .Where(b => b.Id == bookId && b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Pending)
            .ExecuteUpdateAsync(s => s
                .SetProperty(b => b.MetadataEnrichmentStatus, MetadataEnrichmentStatus.Running)
                .SetProperty(b => b.MetadataEnrichmentAt, DateTimeOffset.UtcNow), ct);

        if (claimed == 0) return; // already claimed / not pending — double-trigger safe

        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == bookId, ct);
        if (book is null) return;

        // Nothing to fill → skip the (paid) agent run entirely. Uses the SAME emptiness semantics as the
        // merge/persistence guard (IsNullOrEmpty for Genre/Description, == null for the int? Year). This kills
        // two findings: (a) repeated POST /enrich on a fully-populated book no longer spins a paid OpenAI agent
        // run each time; (b) a transient agent error on a re-enrich of a complete book no longer demotes it to
        // Failed. 'manual' books with all fields present short-circuit here too (the merge would no-op anyway).
        if (!NeedsEnrichment(book))
        {
            book.MetadataEnrichmentStatus = MetadataEnrichmentStatus.Completed;
            book.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return;
        }

        try
        {
            await ApplyEnrichmentAsync(db, book, ct);

            // Terminal even when nothing was filled — this is what kills "forever-enriching".
            book.MetadataEnrichmentStatus = MetadataEnrichmentStatus.Completed;
            book.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // ADR-022: a shutdown gives the claim back instead of failing the book.
            await using var fresh = await dbFactory.CreateDbContextAsync(CancellationToken.None);
            await ReturnClaimAsync(fresh.UserBooks, bookId);
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Metadata enrichment failed for book {BookId}", bookId);
            try
            {
                book.MetadataEnrichmentStatus = MetadataEnrichmentStatus.Failed;
                book.UpdatedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(CancellationToken.None);
            }
            catch (Exception ex2)
            {
                logger.LogWarning(ex2, "Failed to persist Failed enrichment status for {BookId}", bookId);
            }
        }
    }

    /// <summary>ADR-022: Running → Pending, so the worker's next tick (after the restart) runs it again.</summary>
    public static Task<int> ReturnClaimAsync(IQueryable<UserBook> books, Guid bookId) =>
        books.Where(b => b.Id == bookId && b.MetadataEnrichmentStatus == MetadataEnrichmentStatus.Running)
            .ExecuteUpdateAsync(s => s
                .SetProperty(b => b.MetadataEnrichmentStatus, MetadataEnrichmentStatus.Pending), CancellationToken.None);

    /// <summary>
    /// True when at least one target field the merge could fill is still empty (Genre or Description empty, or
    /// Year null). Same emptiness semantics as the persistence guard so a book the merge would no-op on is never
    /// handed to the agent.
    /// </summary>
    private static bool NeedsEnrichment(UserBook book) =>
        string.IsNullOrEmpty(book.Genre)
        || book.PublishedYear == null
        || string.IsNullOrEmpty(book.Description);

    /// <summary>
    /// The extracted ingestion enrichment body: cross-checked/calibrated agent metadata (Ollama fallback
    /// inside <see cref="IBookMetadataGenerator.EnrichAsync"/>) merged into the still-null fields, honouring
    /// the 'manual' SeoSource guard. Mutates <paramref name="book"/> only; the caller owns the SaveChanges +
    /// terminal status transition so the status is stamped whether or not any field changed.
    /// </summary>
    private async Task ApplyEnrichmentAsync(AppDbContext db, UserBook book, CancellationToken ct)
    {
        var needsDescription = string.IsNullOrEmpty(book.Description);
        var excerpt = await db.UserChapters
            .Where(c => c.UserBookId == book.Id)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => c.PlainText)
            .FirstOrDefaultAsync(ct);

        // AI-Agent-1: tool-using, cross-checked, calibrated (Open Library) with the opening excerpt for
        // genre/tone cues. Falls back to Ollama internally on agent error / budget exhaustion / gaps.
        var meta = await metadataGenerator.EnrichAsync(
            book.Id, book.Title, book.Author, excerpt, needsDescription, ct);

        if (meta is null) return;

        // Never overwrite user-edited ('manual') metadata — mirrors the SEO backfill guard.
        if (string.Equals(book.SeoSource, "manual", StringComparison.OrdinalIgnoreCase)) return;

        var changed = false;
        if (meta.Genre != null && string.IsNullOrEmpty(book.Genre))
        { book.Genre = meta.Genre; changed = true; }
        if (meta.PublishedYear != null && book.PublishedYear == null)
        { book.PublishedYear = meta.PublishedYear; changed = true; }
        if (meta.Description != null && string.IsNullOrEmpty(book.Description))
        { book.Description = meta.Description; changed = true; }

        if (changed)
        {
            // Persist provenance/confidence from the agent path (null on the Ollama fallback / hybrid merge).
            if (meta.Confidence is not null) book.MetadataConfidence = meta.Confidence;
            if (meta.ProvenanceJson is not null) book.MetadataProvenanceJson = meta.ProvenanceJson;
        }
    }
}
