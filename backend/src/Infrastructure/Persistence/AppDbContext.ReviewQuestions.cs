using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// <see cref="ReviewQuestion"/> (table <c>review_question</c>), the SRS state of a chapter review's
/// questions (ADR-016). Its insight, <c>book_insight</c>, is not EF any more (ADR-028): the FK and its
/// cascade live in the schema only, so there is no navigation to it.
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): the query filter closes over _currentSite.
    private void ConfigureReviewQuestions(ModelBuilder modelBuilder)
    {
        // A chapter review's SRS questions (ADR-016 §4). Cascades with the insight, so deleting a
        // review never leaves orphaned questions in the due queue.
        modelBuilder.Entity<ReviewQuestion>(e =>
        {
            e.ToTable("review_question");

            e.Property(x => x.Prompt).HasMaxLength(500);
            e.Property(x => x.Answer).HasMaxLength(1500);
            e.Property(x => x.PromptHash).HasMaxLength(16);
            e.Property(x => x.IsRetired).HasDefaultValue(false);

            // A re-save matches questions by prompt, so a prompt appears once per review.
            e.HasIndex(x => new { x.BookInsightId, x.PromptHash }).IsUnique();
            // The due queue: GET /me/review-questions/due.
            e.HasIndex(x => new { x.UserId, x.IsRetired, x.NextReviewAt });

            e.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(x => x.Site)
                .WithMany()
                .HasForeignKey(x => x.SiteId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
