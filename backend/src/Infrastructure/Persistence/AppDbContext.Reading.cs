using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// Per-user reading interactions: progress, bookmarks, notes, highlights,
/// session telemetry, goals, and achievements.
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): site-scoped query filters close over _currentSite.
    private void ConfigureReading(ModelBuilder modelBuilder)
    {
        // ReadingProgress
        modelBuilder.Entity<ReadingProgress>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId }).IsUnique();
            // Same storage as Highlight.AnchorJson, which holds the same shape.
            e.Property(x => x.PositionJson).HasColumnType("jsonb");
            e.HasOne(x => x.User).WithMany(x => x.ReadingProgresses).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Chapter).WithMany(x => x.ReadingProgresses).HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // Bookmark
        modelBuilder.Entity<Bookmark>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId });
            e.HasOne(x => x.User).WithMany(x => x.Bookmarks).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Chapter).WithMany(x => x.Bookmarks).HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // Note
        modelBuilder.Entity<Note>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.HighlightId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId });
            e.HasOne(x => x.User).WithMany(x => x.Notes).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Chapter).WithMany(x => x.Notes).HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Highlight).WithOne(x => x.Note).HasForeignKey<Note>(x => x.HighlightId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // Highlight — can attach to either an Edition+Chapter or a UserBook+UserChapter.
        modelBuilder.Entity<Highlight>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.UserBookId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId }).HasFilter("edition_id IS NOT NULL");
            e.HasIndex(x => new { x.UserId, x.SiteId, x.UserBookId }).HasFilter("user_book_id IS NOT NULL");
            e.Property(x => x.AnchorJson).HasColumnType("jsonb");
            e.Property(x => x.Color).HasMaxLength(20);
            e.HasOne(x => x.User).WithMany(x => x.Highlights).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserChapter).WithMany().HasForeignKey(x => x.UserChapterId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // ReadingSession
        modelBuilder.Entity<ReadingSession>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.SiteId });
            e.HasIndex(x => new { x.UserId, x.StartedAt });
            e.HasIndex(x => new { x.UserId, x.EditionId, x.StartedAt }).IsUnique().HasFilter("edition_id IS NOT NULL");
            e.HasIndex(x => new { x.UserId, x.UserBookId, x.StartedAt }).IsUnique().HasFilter("user_book_id IS NOT NULL");
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.UserBook).WithMany().HasForeignKey(x => x.UserBookId).OnDelete(DeleteBehavior.SetNull);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // ReadingGoal
        modelBuilder.Entity<ReadingGoal>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.SiteId });
            e.HasIndex(x => new { x.UserId, x.SiteId, x.GoalType }).IsUnique();
            e.Property(x => x.GoalType).HasMaxLength(50);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // UserAchievement
        modelBuilder.Entity<UserAchievement>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.SiteId });
            e.HasIndex(x => new { x.UserId, x.SiteId, x.AchievementCode }).IsUnique();
            e.Property(x => x.AchievementCode).HasMaxLength(50);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
