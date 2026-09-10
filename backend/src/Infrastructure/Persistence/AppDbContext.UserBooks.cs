using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// User-uploaded book pipeline: UserBook + chapters/files/ingestion +
/// per-user bookmarks for uploads + BookQualityJob (tightly coupled to
/// the upload quality-scoring loop).
/// </summary>
public partial class AppDbContext
{
    private static void ConfigureUserBooks(ModelBuilder modelBuilder)
    {
        // UserBook
        modelBuilder.Entity<UserBook>(e =>
        {
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => new { x.UserId, x.Slug }).IsUnique();
            e.Property(x => x.Title).HasMaxLength(500);
            e.Property(x => x.Slug).HasMaxLength(500);
            e.Property(x => x.Language).HasMaxLength(10);
            e.Property(x => x.Author).HasMaxLength(500);
            e.Property(x => x.CoverPath).HasMaxLength(500);
            e.Property(x => x.Genre).HasMaxLength(200);
            e.Property(x => x.TocJson).HasColumnType("jsonb");
            // Same storage as Highlight.AnchorJson and ReadingProgress.PositionJson.
            e.Property(x => x.ProgressPositionJson).HasColumnType("jsonb");
            e.Property(x => x.TakedownReason).HasMaxLength(1000);
            e.Property(x => x.SeoSource).HasMaxLength(20).HasDefaultValue("auto");
            e.Property(x => x.MetadataHistoryJson).HasColumnType("jsonb");
            // Enrichment agent provenance (AI-Agent-1): calibrated confidence + per-field source map.
            e.Property(x => x.MetadataConfidence).HasColumnType("double precision");
            e.Property(x => x.MetadataProvenanceJson).HasColumnType("jsonb");
            // Visible enrichment lifecycle. Stored as int (enum→int convention); NotStarted=0 default so
            // the pre-feature backlog stays badge-hidden. MetadataEnrichmentAt stamps the Running claim.
            e.Property(x => x.MetadataEnrichmentStatus)
                .HasConversion<int>()
                .HasDefaultValue(MetadataEnrichmentStatus.NotStarted);
            e.Property(x => x.Tags).HasColumnType("text[]").HasDefaultValueSql("ARRAY[]::text[]");
            e.HasIndex(x => x.Tags).HasMethod("gin");
            e.Property(x => x.SuggestedTags).HasColumnType("text[]").HasDefaultValueSql("ARRAY[]::text[]");
            // "Send to TextStack" clip fields. IsClip/IsRead NOT NULL default false.
            e.Property(x => x.SourceUrl).HasMaxLength(2048);
            e.Property(x => x.IsClip).HasDefaultValue(false);
            e.Property(x => x.IsRead).HasDefaultValue(false);
            e.HasIndex(x => new { x.UserId, x.IsClip });
            e.HasOne(x => x.User).WithMany(x => x.UserBooks).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserChapter
        modelBuilder.Entity<UserChapter>(e =>
        {
            e.HasIndex(x => x.UserBookId);
            e.HasIndex(x => new { x.UserBookId, x.ChapterNumber }).IsUnique();
            e.HasIndex(x => new { x.UserBookId, x.Slug }).IsUnique();
            e.Property(x => x.Title).HasMaxLength(500);
            e.Property(x => x.Slug).HasMaxLength(255);
            e.HasOne(x => x.UserBook).WithMany(x => x.Chapters).HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserBookFile
        modelBuilder.Entity<UserBookFile>(e =>
        {
            e.HasIndex(x => x.UserBookId);
            e.HasIndex(x => x.Sha256);
            e.Property(x => x.OriginalFileName).HasMaxLength(500);
            e.Property(x => x.StoragePath).HasMaxLength(500);
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.HasOne(x => x.UserBook).WithMany(x => x.BookFiles).HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserIngestionJob
        modelBuilder.Entity<UserIngestionJob>(e =>
        {
            e.HasIndex(x => x.UserBookId);
            e.HasIndex(x => x.UserBookFileId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.CreatedAt);
            e.Property(x => x.SourceFormat).HasMaxLength(50);
            e.HasOne(x => x.UserBook).WithMany(x => x.IngestionJobs).HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.UserBookFile).WithMany().HasForeignKey(x => x.UserBookFileId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserBookBookmark
        modelBuilder.Entity<UserBookBookmark>(e =>
        {
            e.ToTable("user_book_bookmarks");
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.UserBookId);
            e.Property(x => x.Locator).HasMaxLength(1000);
            e.Property(x => x.Title).HasMaxLength(500);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.Cascade);
            // Nullable chapter FK: page bookmarks on chapterless PDFs (ADR-012) have no
            // chapter. SetNull so deleting a chapter demotes its bookmarks to page anchors
            // rather than cascading them away.
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.SetNull);
        });

        // BookQualityJob — tracks Phase 3 content-quality cleanup runs.
        // Lives with user books because most jobs target user uploads;
        // edition jobs are admin-side rare.
        modelBuilder.Entity<BookQualityJob>(e =>
        {
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.UserBookId);
            e.Property(x => x.IssuesJson).HasColumnType("jsonb");
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
