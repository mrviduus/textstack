using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

public class AppDbContext : DbContext, IAppDbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Site> Sites => Set<Site>();
    public DbSet<SiteDomain> SiteDomains => Set<SiteDomain>();
    public DbSet<Work> Works => Set<Work>();
    public DbSet<Edition> Editions => Set<Edition>();
    public DbSet<Chapter> Chapters => Set<Chapter>();
    public DbSet<BookFile> BookFiles => Set<BookFile>();
    public DbSet<IngestionJob> IngestionJobs => Set<IngestionJob>();
    public DbSet<User> Users => Set<User>();
    public DbSet<UserLibrary> UserLibraries => Set<UserLibrary>();
    public DbSet<ReadingProgress> ReadingProgresses => Set<ReadingProgress>();
    public DbSet<Bookmark> Bookmarks => Set<Bookmark>();
    public DbSet<Note> Notes => Set<Note>();
    public DbSet<AdminUser> AdminUsers => Set<AdminUser>();
    public DbSet<AdminRefreshToken> AdminRefreshTokens => Set<AdminRefreshToken>();
    public DbSet<UserRefreshToken> UserRefreshTokens => Set<UserRefreshToken>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<EditionAuthor> EditionAuthors => Set<EditionAuthor>();
    public DbSet<Genre> Genres => Set<Genre>();
    public DbSet<TextStackImport> TextStackImports => Set<TextStackImport>();
    public DbSet<SeoCrawlJob> SeoCrawlJobs => Set<SeoCrawlJob>();
    public DbSet<SeoCrawlResult> SeoCrawlResults => Set<SeoCrawlResult>();
    public DbSet<SsgRebuildJob> SsgRebuildJobs => Set<SsgRebuildJob>();
    public DbSet<SsgRebuildResult> SsgRebuildResults => Set<SsgRebuildResult>();
    public DbSet<BookAsset> BookAssets => Set<BookAsset>();
    public DbSet<LintResult> LintResults => Set<LintResult>();
    public DbSet<UserBook> UserBooks => Set<UserBook>();
    public DbSet<UserChapter> UserChapters => Set<UserChapter>();
    public DbSet<UserBookFile> UserBookFiles => Set<UserBookFile>();
    public DbSet<UserIngestionJob> UserIngestionJobs => Set<UserIngestionJob>();
    public DbSet<UserBookBookmark> UserBookBookmarks => Set<UserBookBookmark>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Site
        modelBuilder.Entity<Site>(e =>
        {
            e.HasIndex(x => x.Code).IsUnique();
            e.HasIndex(x => x.PrimaryDomain).IsUnique();
            e.Property(x => x.Code).HasMaxLength(50);
            e.Property(x => x.PrimaryDomain).HasMaxLength(255);
            e.Property(x => x.DefaultLanguage).HasMaxLength(10);
            e.Property(x => x.Theme).HasMaxLength(50);
            e.Property(x => x.FeaturesJson).HasColumnType("jsonb");
        });

        // SiteDomain
        modelBuilder.Entity<SiteDomain>(e =>
        {
            e.HasIndex(x => x.Domain).IsUnique();
            e.Property(x => x.Domain).HasMaxLength(255);
            e.HasOne(x => x.Site).WithMany(x => x.Domains).HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Cascade);
        });

        // Work
        modelBuilder.Entity<Work>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.SiteId, x.Slug }).IsUnique();
            e.HasOne(x => x.Site).WithMany(x => x.Works).HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
        });

        // Edition
        modelBuilder.Entity<Edition>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.SourceEditionId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => new { x.WorkId, x.Language }).IsUnique();
            e.HasIndex(x => new { x.SiteId, x.Language, x.Slug }).IsUnique();
            e.Property(x => x.Language).HasMaxLength(8);
            e.Property(x => x.TocJson).HasColumnType("jsonb");
            e.HasOne(x => x.Work).WithMany(x => x.Editions).HasForeignKey(x => x.WorkId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.SourceEdition).WithMany(x => x.TranslatedEditions).HasForeignKey(x => x.SourceEditionId).OnDelete(DeleteBehavior.SetNull);
        });

        // Chapter
        modelBuilder.Entity<Chapter>(e =>
        {
            e.HasIndex(x => new { x.EditionId, x.ChapterNumber }).IsUnique();
            e.HasIndex(x => new { x.EditionId, x.Slug });
            e.HasIndex(x => x.SearchVector).HasMethod("GIN");
            e.Property(x => x.SearchVector).HasColumnType("tsvector");
            e.HasOne(x => x.Edition).WithMany(x => x.Chapters).HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // BookFile
        modelBuilder.Entity<BookFile>(e =>
        {
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.Sha256);
            e.HasOne(x => x.Edition).WithMany(x => x.BookFiles).HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // IngestionJob
        modelBuilder.Entity<IngestionJob>(e =>
        {
            e.HasIndex(x => x.BookFileId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SourceEditionId);
            e.HasIndex(x => x.WorkId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.CreatedAt);
            e.Property(x => x.TargetLanguage).HasMaxLength(8);
            e.Property(x => x.SourceFormat).HasMaxLength(20);
            e.Property(x => x.TextSource).HasMaxLength(20);
            e.Property(x => x.WarningsJson).HasColumnType("jsonb");
            e.HasOne(x => x.BookFile).WithMany(x => x.IngestionJobs).HasForeignKey(x => x.BookFileId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany(x => x.IngestionJobs).HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.SourceEdition).WithMany().HasForeignKey(x => x.SourceEditionId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Work).WithMany().HasForeignKey(x => x.WorkId).OnDelete(DeleteBehavior.SetNull);
        });

        // User
        modelBuilder.Entity<User>(e =>
        {
            e.HasIndex(x => x.Email).IsUnique();
            e.HasIndex(x => x.GoogleSubject).IsUnique();
            e.Property(x => x.Email).HasMaxLength(255);
            e.Property(x => x.GoogleSubject).HasMaxLength(255);
            e.Property(x => x.Name).HasMaxLength(255);
        });

        // UserLibrary
        modelBuilder.Entity<UserLibrary>(e =>
        {
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => new { x.UserId, x.EditionId }).IsUnique();
            e.HasOne(x => x.User).WithMany(x => x.UserLibraries).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // ReadingProgress
        modelBuilder.Entity<ReadingProgress>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId }).IsUnique();
            e.HasOne(x => x.User).WithMany(x => x.ReadingProgresses).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Chapter).WithMany(x => x.ReadingProgresses).HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
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
        });

        // Note
        modelBuilder.Entity<Note>(e =>
        {
            e.HasIndex(x => x.ChapterId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.UserId, x.SiteId, x.EditionId });
            e.HasOne(x => x.User).WithMany(x => x.Notes).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Chapter).WithMany(x => x.Notes).HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
        });

        // AdminUser
        modelBuilder.Entity<AdminUser>(e =>
        {
            e.HasIndex(x => x.Email).IsUnique();
        });

        // AdminRefreshToken
        modelBuilder.Entity<AdminRefreshToken>(e =>
        {
            e.HasIndex(x => x.AdminUserId);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.Token).IsUnique();
            e.HasOne(x => x.AdminUser).WithMany(x => x.RefreshTokens).HasForeignKey(x => x.AdminUserId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserRefreshToken
        modelBuilder.Entity<UserRefreshToken>(e =>
        {
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.Token).IsUnique();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // Author
        modelBuilder.Entity<Author>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.SiteId, x.Slug }).IsUnique();
            e.Property(x => x.Slug).HasMaxLength(255);
            e.Property(x => x.Name).HasMaxLength(255);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
        });

        // EditionAuthor (junction table with order + role)
        modelBuilder.Entity<EditionAuthor>(e =>
        {
            e.ToTable("edition_authors");
            e.HasKey(x => new { x.EditionId, x.AuthorId });
            e.HasIndex(x => x.AuthorId);
            e.Property(x => x.Role).HasConversion<string>().HasMaxLength(50);
            e.HasOne(x => x.Edition).WithMany(x => x.EditionAuthors).HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Author).WithMany(x => x.EditionAuthors).HasForeignKey(x => x.AuthorId).OnDelete(DeleteBehavior.Cascade);
        });

        // Genre
        modelBuilder.Entity<Genre>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => new { x.SiteId, x.Slug }).IsUnique();
            e.Property(x => x.Slug).HasMaxLength(100);
            e.Property(x => x.Name).HasMaxLength(100);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasMany(x => x.Editions).WithMany(x => x.Genres).UsingEntity("edition_genres");
        });

        // TextStackImport
        modelBuilder.Entity<TextStackImport>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => new { x.SiteId, x.Identifier }).IsUnique();
            e.Property(x => x.Identifier).HasMaxLength(500);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // SeoCrawlJob
        modelBuilder.Entity<SeoCrawlJob>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.CreatedAt);
            e.Property(x => x.UserAgent).HasMaxLength(500);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
        });

        // SeoCrawlResult
        modelBuilder.Entity<SeoCrawlResult>(e =>
        {
            e.HasIndex(x => x.JobId);
            e.HasIndex(x => new { x.JobId, x.Url }).IsUnique();
            e.HasIndex(x => new { x.JobId, x.StatusCode });
            e.Property(x => x.Url).HasMaxLength(2048);
            e.Property(x => x.UrlType).HasMaxLength(20);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.Property(x => x.Title).HasMaxLength(1000);
            e.Property(x => x.MetaDescription).HasMaxLength(2000);
            e.Property(x => x.H1).HasMaxLength(1000);
            e.Property(x => x.Canonical).HasMaxLength(2048);
            e.Property(x => x.MetaRobots).HasMaxLength(100);
            e.Property(x => x.XRobotsTag).HasMaxLength(100);
            e.HasOne(x => x.Job).WithMany(x => x.Results).HasForeignKey(x => x.JobId).OnDelete(DeleteBehavior.Cascade);
        });

        // BookAsset
        modelBuilder.Entity<BookAsset>(e =>
        {
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => new { x.EditionId, x.OriginalPath }).IsUnique();
            e.Property(x => x.Kind).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.OriginalPath).HasMaxLength(500);
            e.Property(x => x.StoragePath).HasMaxLength(500);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.HasOne(x => x.Edition).WithMany(x => x.Assets).HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // SsgRebuildJob
        modelBuilder.Entity<SsgRebuildJob>(e =>
        {
            e.HasIndex(x => x.SiteId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.CreatedAt);
            e.Property(x => x.Mode).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.BookSlugsJson).HasColumnType("jsonb");
            e.Property(x => x.AuthorSlugsJson).HasColumnType("jsonb");
            e.Property(x => x.GenreSlugsJson).HasColumnType("jsonb");
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Restrict);
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

        // UserBook
        modelBuilder.Entity<UserBook>(e =>
        {
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.Status);
            e.HasIndex(x => new { x.UserId, x.Slug }).IsUnique();
            e.Property(x => x.Title).HasMaxLength(500);
            e.Property(x => x.Slug).HasMaxLength(500);
            e.Property(x => x.Language).HasMaxLength(10);
            e.Property(x => x.CoverPath).HasMaxLength(500);
            e.Property(x => x.TocJson).HasColumnType("jsonb");
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
            e.HasOne(x => x.Chapter).WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
        });
    }

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        base.OnConfiguring(optionsBuilder);
        optionsBuilder.UseSnakeCaseNamingConvention();
    }
}
