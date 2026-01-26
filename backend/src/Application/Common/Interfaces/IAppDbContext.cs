using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.Common.Interfaces;

public interface IAppDbContext
{
    DbSet<Site> Sites { get; }
    DbSet<SiteDomain> SiteDomains { get; }
    DbSet<Work> Works { get; }
    DbSet<Edition> Editions { get; }
    DbSet<Chapter> Chapters { get; }
    DbSet<BookFile> BookFiles { get; }
    DbSet<IngestionJob> IngestionJobs { get; }
    DbSet<User> Users { get; }
    DbSet<UserLibrary> UserLibraries { get; }
    DbSet<ReadingProgress> ReadingProgresses { get; }
    DbSet<Bookmark> Bookmarks { get; }
    DbSet<Note> Notes { get; }
    DbSet<AdminUser> AdminUsers { get; }
    DbSet<AdminRefreshToken> AdminRefreshTokens { get; }
    DbSet<UserRefreshToken> UserRefreshTokens { get; }
    DbSet<Author> Authors { get; }
    DbSet<EditionAuthor> EditionAuthors { get; }
    DbSet<Genre> Genres { get; }
    DbSet<TextStackImport> TextStackImports { get; }
    DbSet<SeoCrawlJob> SeoCrawlJobs { get; }
    DbSet<SeoCrawlResult> SeoCrawlResults { get; }
    DbSet<SsgRebuildJob> SsgRebuildJobs { get; }
    DbSet<SsgRebuildResult> SsgRebuildResults { get; }
    DbSet<BookAsset> BookAssets { get; }
    DbSet<LintResult> LintResults { get; }
    DbSet<UserBook> UserBooks { get; }
    DbSet<UserChapter> UserChapters { get; }
    DbSet<UserBookFile> UserBookFiles { get; }
    DbSet<UserIngestionJob> UserIngestionJobs { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
