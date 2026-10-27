using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// SRS vocabulary + anti-spiral entities: VocabularyWord + reviews +
/// per-user settings + PendingVocabularyWord (over-cap buffer, F2) +
/// WordLookup (rare-word taps, F1) +
/// WordCluster (LLM-grouped bonus rounds, F3).
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): site-scoped query filters close over _currentSite.
    private void ConfigureVocabulary(ModelBuilder modelBuilder)
    {
        // VocabularyWord
        modelBuilder.Entity<VocabularyWord>(e =>
        {
            // Phase 1 anti-spiral: retired rows are excluded from queue — index on IsRetired
            // so the filtered scan is a tight prefix read, not a full index scan + filter.
            e.HasIndex(x => new { x.UserId, x.SiteId, x.IsRetired, x.NextReviewAt });
            e.HasIndex(x => new { x.UserId, x.SiteId, x.Word, x.Language }).IsUnique();
            e.HasIndex(x => x.EditionId);
            e.Property(x => x.Word).HasMaxLength(200);
            e.Property(x => x.Language).HasMaxLength(8);
            e.Property(x => x.Translation).HasMaxLength(500);
            e.Property(x => x.Definition).HasMaxLength(2000);
            e.Property(x => x.Sentence).HasMaxLength(1000);
            e.Property(x => x.BookTitle).HasMaxLength(500);
            e.Property(x => x.Hint).HasMaxLength(500);
            e.Property(x => x.Explanation).HasMaxLength(1000);
            e.Property(x => x.Source).HasMaxLength(40);
            e.Property(x => x.RetiredReason).HasMaxLength(60);

            // AI-058: OpenAI word embedding, float[] <-> pgvector vector(1536) — the only
            // vector column left (the RAG tables went 2026-09-10). NULL until
            // embedded at save / backfill. NO HNSW index — concept clustering is an
            // in-memory N²/2 pass over a single user's ≤300 vectors, not a SQL ANN scan.
            e.Property(x => x.Embedding)
                .HasColumnType("vector(1536)")
                .HasConversion(
                    v => v == null ? null : new Pgvector.Vector(v),
                    v => v == null ? null : v.ToArray());
            // AI-058: index on the concept-cluster FK for member lookups + full-replace deletes.
            e.HasIndex(x => x.ConceptClusterId);

            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            // AI-058: concept-cluster FK — SetNull on delete so the full-replace rebuild
            // (delete this user's concept clusters → recreate) nulls members cleanly.
            e.HasOne(x => x.ConceptCluster).WithMany(c => c.ConceptWords)
                .HasForeignKey(x => x.ConceptClusterId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // UserVocabularySettings — one row per (user, site).
        modelBuilder.Entity<UserVocabularySettings>(e =>
        {
            e.HasKey(x => new { x.UserId, x.SiteId });
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // VocabularyReview
        modelBuilder.Entity<VocabularyReview>(e =>
        {
            e.HasIndex(x => x.VocabularyWordId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.CreatedAt });
            e.Property(x => x.ReviewMode).HasMaxLength(30);
            e.HasOne(x => x.VocabularyWord).WithMany(x => x.Reviews).HasForeignKey(x => x.VocabularyWordId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // PendingVocabularyWord (F2: over-cap buffer)
        modelBuilder.Entity<PendingVocabularyWord>(e =>
        {
            // Promotion-order read: top-N by Priority DESC per user.
            e.HasIndex(x => new { x.UserId, x.SiteId, x.Priority }).IsDescending(false, false, true);
            // Dedup + list view (newest first).
            e.HasIndex(x => new { x.UserId, x.SiteId, x.CreatedAt });
            // Guard against duplicate pending rows for the same word.
            e.HasIndex(x => new { x.UserId, x.SiteId, x.Word, x.Language }).IsUnique();
            e.Property(x => x.Word).HasMaxLength(200);
            e.Property(x => x.Language).HasMaxLength(8);
            e.Property(x => x.Translation).HasMaxLength(500);
            e.Property(x => x.Definition).HasMaxLength(2000);
            e.Property(x => x.Sentence).HasMaxLength(1000);
            e.Property(x => x.BookTitle).HasMaxLength(500);
            e.Property(x => x.Source).HasMaxLength(40);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // WordLookup (F1: rare-word reference bucket — taps that don't enter SRS)
        modelBuilder.Entity<WordLookup>(e =>
        {
            // Dedup: one row per (user, site, word, language). Tap increments TapCount.
            e.HasIndex(x => new { x.UserId, x.SiteId, x.Word, x.Language }).IsUnique();
            // List view (newest tapped first).
            e.HasIndex(x => new { x.UserId, x.SiteId, x.LastTappedAt }).IsDescending(false, false, true);
            e.Property(x => x.Word).HasMaxLength(200);
            e.Property(x => x.Language).HasMaxLength(8);
            e.Property(x => x.Sentence).HasMaxLength(1000);
            e.Property(x => x.BookTitle).HasMaxLength(500);
            e.Property(x => x.LastTranslation).HasMaxLength(500);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // WordCluster (F3: LLM-grouped thematic bonus rounds)
        modelBuilder.Entity<WordCluster>(e =>
        {
            // List view — active (undismissed) clusters per user, newest first.
            e.HasIndex(x => new { x.UserId, x.SiteId, x.IsDismissed, x.CreatedAt }).IsDescending(false, false, false, true);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Theme).HasMaxLength(100);
            e.Property(x => x.BookTitle).HasMaxLength(500);
            // AI-058: "book" (legacy book-grouper, default — existing rows backfilled to it
            // by the migration) | "concept" (semantic concept-grouper, spans all books).
            e.Property(x => x.Kind).HasMaxLength(16).HasDefaultValue("book");
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            e.HasMany(x => x.Words).WithOne().HasForeignKey(x => x.ClusterId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
