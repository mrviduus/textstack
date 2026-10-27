using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// Per-user book collections (my-books-v2 slice 13) — user-defined folders
/// that mix catalog editions + user uploads.
/// </summary>
public partial class AppDbContext
{
    private static void ConfigureCollections(ModelBuilder modelBuilder)
    {
        // Collection
        modelBuilder.Entity<Collection>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.SortOrder });
            e.Property(x => x.Name).HasMaxLength(100).IsRequired();
            e.Property(x => x.Color).HasMaxLength(20).HasDefaultValue("default");
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // BookCollection — composite PK on (CollectionId, BookId, BookType)
        // so the same collection can hold both edition IDs and user-book IDs
        // without a UUID collision masking double-add of a single source.
        modelBuilder.Entity<BookCollection>(e =>
        {
            e.HasKey(x => new { x.CollectionId, x.BookId, x.BookType });
            e.HasIndex(x => x.BookId);
            e.Property(x => x.BookType).HasMaxLength(20).IsRequired();
            e.HasOne(x => x.Collection).WithMany(c => c.Books).HasForeignKey(x => x.CollectionId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
