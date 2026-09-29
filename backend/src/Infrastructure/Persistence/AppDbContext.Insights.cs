using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// <see cref="BookInsight"/> (table <c>book_insight</c>) — conclusions written back into a book by an
/// outside assistant over MCP. snake_case names come from the global convention (OnConfiguring).
/// XOR CHECK on the book target, ISiteScoped
/// filter, cascade FKs. Also <see cref="ReviewQuestion"/> (table <c>review_question</c>), the SRS state
/// of a chapter review's questions (ADR-016).
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): the query filter closes over _currentSite.
    private void ConfigureInsights(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<BookInsight>(e =>
        {
            e.ToTable("book_insight", t =>
                // Exactly one of edition_id / user_book_id is set (an insight is about one book).
                t.HasCheckConstraint(
                    "ck_book_insight_target",
                    "(edition_id IS NOT NULL AND user_book_id IS NULL) OR (edition_id IS NULL AND user_book_id IS NOT NULL)"));

            e.Property(x => x.Text).HasColumnType("text");
            e.Property(x => x.Question).HasMaxLength(1000);
            e.Property(x => x.Source).HasMaxLength(32).HasDefaultValue("mcp");
            e.Property(x => x.ChapterSlug).HasMaxLength(300);
            e.Property(x => x.ReviewJson).HasColumnType("jsonb");

            // One insight per user + book + chapter, so a re-run replaces rather than accumulates
            // (see the entity docs).
            //
            // AreNullsDistinct(false) is load-bearing, not tidiness. By default Postgres treats NULLs
            // in a unique index as distinct from each other, and chapter_slug IS NULL is the
            // book-level insight — the конспект's overview, the single row most likely to be
            // rewritten. Left default, that one row would be the only one the constraint did not
            // protect, and it would silently accumulate a duplicate per pass. Requires PG15+; we are
            // on 16.
            //
            // The two indexes are filtered so the NULL side of the edition/user_book XOR cannot
            // collide across the other book type's rows.
            e.HasIndex("UserId", "EditionId", "ChapterSlug")
                .IsUnique()
                .AreNullsDistinct(false)
                .HasFilter("edition_id IS NOT NULL");
            e.HasIndex("UserId", "UserBookId", "ChapterSlug")
                .IsUnique()
                .AreNullsDistinct(false)
                .HasFilter("user_book_id IS NOT NULL");

            e.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(x => x.Site)
                .WithMany()
                .HasForeignKey(x => x.SiteId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(x => x.Edition)
                .WithMany()
                .HasForeignKey(x => x.EditionId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(x => x.UserBook)
                .WithMany()
                .HasForeignKey(x => x.UserBookId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });

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

            e.HasOne(x => x.BookInsight)
                .WithMany()
                .HasForeignKey(x => x.BookInsightId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
