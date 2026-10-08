using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// Operational entities — admin settings + SSG rebuild bookkeeping +
/// lint result rows. Not tied to a single product domain.
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): site-scoped query filters close over _currentSite.
    private void ConfigureOps(ModelBuilder modelBuilder)
    {
        // AdminSettings — key/value store, primary key is the key string.
        modelBuilder.Entity<AdminSettings>(e =>
        {
            e.HasKey(x => x.Key);
            e.Property(x => x.Key).HasMaxLength(100);
            e.Property(x => x.Value).HasMaxLength(500);
        });

        // SsgRebuildJob
        modelBuilder.Entity<SsgRebuildJob>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.CreatedAt);
            // Full is the only mode; any legacy string (Incremental, Specific) reads as Full, never throws.
            e.Property(x => x.Mode).HasConversion(v => v.ToString(), _ => Domain.Enums.SsgRebuildMode.Full).HasMaxLength(20);
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.BookSlugsJson).HasColumnType("jsonb");
            e.Property(x => x.AuthorSlugsJson).HasColumnType("jsonb");
            e.Property(x => x.GenreSlugsJson).HasColumnType("jsonb");
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

        // SsgRebuildResult
        modelBuilder.Entity<SsgRebuildResult>(e =>
        {
            e.HasIndex(x => x.JobId);
            e.HasIndex(x => new { x.JobId, x.Route }).IsUnique();
            e.Property(x => x.Route).HasMaxLength(500);
            e.Property(x => x.RouteType).HasMaxLength(20);
            e.HasOne(x => x.Job).WithMany(x => x.Results).HasForeignKey(x => x.JobId).OnDelete(DeleteBehavior.Cascade);
        });

        // LintResult
        modelBuilder.Entity<LintResult>(e =>
        {
            e.HasIndex(x => x.EditionId);
            e.Property(x => x.Severity).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.Code).HasMaxLength(10);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // AutoPublishJob — otherwise convention-configured; here only to carry the
        // R1b site-scoped query filter (no schema config, so no migration delta).
        modelBuilder.Entity<AutoPublishJob>(e =>
        {
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
