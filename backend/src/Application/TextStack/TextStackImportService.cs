using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using OnlineLib.Search.Abstractions;
using OnlineLib.Search.Contracts;
using OnlineLib.Search.Enums;

namespace Application.TextStack;

public record ImportResult(Guid EditionId, int ChapterCount, bool WasSkipped, string? Error = null);

public class TextStackImportService
{
    private readonly IAppDbContext _db;
    private readonly IFileStorageService _storage;
    private readonly ISearchIndexer _searchIndexer;
    private readonly ILogger<TextStackImportService> _logger;

    public TextStackImportService(
        IAppDbContext db,
        IFileStorageService storage,
        ISearchIndexer searchIndexer,
        ILogger<TextStackImportService> logger)
    {
        _db = db;
        _storage = storage;
        _searchIndexer = searchIndexer;
        _logger = logger;
    }

    public async Task<bool> IsAlreadyImportedAsync(Guid siteId, string identifier, CancellationToken ct)
    {
        return await _db.TextStackImports
            .AnyAsync(i => i.SiteId == siteId && i.Identifier == identifier, ct);
    }

    public async Task<ImportResult> ImportBookAsync(Guid siteId, string bookPath, CancellationToken ct)
    {
        var identifier = Path.GetFileName(bookPath);

        if (await IsAlreadyImportedAsync(siteId, identifier, ct))
        {
            _logger.LogInformation("Book already imported: {Identifier}", identifier);
            return new ImportResult(Guid.Empty, 0, WasSkipped: true);
        }

        try
        {
            // 1. Parse OPF
            var opfPath = Path.Combine(bookPath, "src/epub/content.opf");
            if (!File.Exists(opfPath))
            {
                return new ImportResult(Guid.Empty, 0, false, $"content.opf not found at {opfPath}");
            }

            var metadata = OpfParser.Parse(opfPath);
            _logger.LogInformation("Parsed metadata for {Title}", metadata.Title);

            // 2. Find/create Author
            if (metadata.AuthorNames.Count == 0)
            {
                return new ImportResult(Guid.Empty, 0, false, "No author found in metadata");
            }

            var author = await FindOrCreateAuthorAsync(siteId, metadata.AuthorNames[0], ct);

            // 3. Find/create Genres
            var genres = new List<Genre>();
            foreach (var subject in metadata.Subjects)
            {
                var genre = await FindOrCreateGenreAsync(siteId, subject, ct);
                genres.Add(genre);
            }

            // 4. Create Work + Edition
            // Include author in slug to differentiate works with same title by different authors
            var authorSlug = metadata.AuthorNames.Count > 0
                ? SlugGenerator.GenerateSlug(metadata.AuthorNames[0])
                : "unknown";
            var workSlug = $"{authorSlug}-{SlugGenerator.GenerateSlug(metadata.Title)}";
            var work = await _db.Works.FirstOrDefaultAsync(w => w.SiteId == siteId && w.Slug == workSlug, ct);

            if (work == null)
            {
                work = new Work
                {
                    Id = Guid.NewGuid(),
                    SiteId = siteId,
                    Slug = workSlug,
                    CreatedAt = DateTimeOffset.UtcNow
                };
                _db.Works.Add(work);
            }

            var editionSlug = await GenerateUniqueEditionSlugAsync(siteId, metadata.Title, metadata.Language, ct);
            var edition = new Edition
            {
                Id = Guid.NewGuid(),
                WorkId = work.Id,
                SiteId = siteId,
                Language = metadata.Language,
                Slug = editionSlug,
                Title = metadata.Title,
                Description = metadata.LongDescription ?? metadata.Description,
                Status = EditionStatus.Draft,  // Import as draft for review
                PublishedAt = null,
                IsPublicDomain = true,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            _db.Editions.Add(edition);

            // 5. Copy cover
            await CopyCoverAsync(bookPath, edition.Id, ct);

            // 6. Parse + create chapters
            var tocPath = Path.Combine(bookPath, "src/epub/toc.xhtml");
            var textDir = Path.Combine(bookPath, "src/epub/text");

            if (!File.Exists(tocPath))
            {
                return new ImportResult(Guid.Empty, 0, false, $"toc.xhtml not found at {tocPath}");
            }

            var chapters = XhtmlChapterParser.ParseFromToc(tocPath, textDir);
            _logger.LogInformation("Parsed {Count} chapters", chapters.Count);

            foreach (var ch in chapters)
            {
                var chapterSlug = SlugGenerator.GenerateChapterSlug(ch.Title, ch.Order);
                var chapter = new Chapter
                {
                    Id = Guid.NewGuid(),
                    EditionId = edition.Id,
                    ChapterNumber = ch.Order,
                    Slug = chapterSlug,
                    Title = SanitizeText(ch.Title),
                    Html = SanitizeText(ch.Html),
                    PlainText = SanitizeText(ch.PlainText),
                    WordCount = ch.WordCount,
                    CreatedAt = DateTimeOffset.UtcNow,
                    UpdatedAt = DateTimeOffset.UtcNow
                };
                _db.Chapters.Add(chapter);
            }

            // 7. Link EditionAuthor
            _db.EditionAuthors.Add(new EditionAuthor
            {
                EditionId = edition.Id,
                AuthorId = author.Id,
                Order = 0,
                Role = AuthorRole.Author
            });

            // 8. Link Genres
            edition.Genres = genres;

            // 9. Record import
            _db.TextStackImports.Add(new TextStackImport
            {
                Id = Guid.NewGuid(),
                SiteId = siteId,
                Identifier = identifier,
                EditionId = edition.Id,
                ImportedAt = DateTimeOffset.UtcNow
            });

            await _db.SaveChangesAsync(ct);

            // Skip search indexing - will be indexed when published
            _logger.LogInformation("Imported {Title} as draft with {ChapterCount} chapters", metadata.Title, chapters.Count);
            return new ImportResult(edition.Id, chapters.Count, WasSkipped: false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to import {BookPath}", bookPath);
            return new ImportResult(Guid.Empty, 0, false, ex.Message);
        }
    }

    private async Task<Author> FindOrCreateAuthorAsync(Guid siteId, string name, CancellationToken ct)
    {
        var slug = SlugGenerator.GenerateSlug(name);
        var existing = await _db.Authors
            .FirstOrDefaultAsync(a => a.SiteId == siteId && a.Slug == slug, ct);

        if (existing is not null)
            return existing;

        var author = new Author
        {
            Id = Guid.NewGuid(),
            SiteId = siteId,
            Slug = slug,
            Name = name,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        _db.Authors.Add(author);
        await _db.SaveChangesAsync(ct); // Save immediately to avoid duplicates
        return author;
    }

    private async Task<Genre> FindOrCreateGenreAsync(Guid siteId, string name, CancellationToken ct)
    {
        var slug = SlugGenerator.GenerateSlug(name);
        var existing = await _db.Genres
            .FirstOrDefaultAsync(g => g.SiteId == siteId && g.Slug == slug, ct);

        if (existing is not null)
            return existing;

        var genre = new Genre
        {
            Id = Guid.NewGuid(),
            SiteId = siteId,
            Slug = slug,
            Name = name,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        _db.Genres.Add(genre);
        await _db.SaveChangesAsync(ct); // Save immediately to avoid duplicates
        return genre;
    }

    private async Task<string> GenerateUniqueEditionSlugAsync(
        Guid siteId, string title, string language, CancellationToken ct)
    {
        var baseSlug = SlugGenerator.GenerateSlug(title);
        var slug = baseSlug;
        var counter = 1;

        while (await _db.Editions.AnyAsync(e => e.SiteId == siteId && e.Language == language && e.Slug == slug, ct))
        {
            slug = $"{baseSlug}-{counter}";
            counter++;
        }

        return slug;
    }

    private async Task CopyCoverAsync(string bookPath, Guid editionId, CancellationToken ct)
    {
        // Try different cover locations
        var coverPaths = new[]
        {
            Path.Combine(bookPath, "images/cover.jpg"),
            Path.Combine(bookPath, "images/cover.png"),
            Path.Combine(bookPath, "src/epub/images/cover.jpg"),
            Path.Combine(bookPath, "src/epub/images/cover.png")
        };

        foreach (var coverPath in coverPaths)
        {
            if (!File.Exists(coverPath))
                continue;

            try
            {
                await using var stream = File.OpenRead(coverPath);
                var ext = Path.GetExtension(coverPath);
                var storagePath = await _storage.SaveFileAsync(editionId, $"cover{ext}", stream, ct);

                var edition = await _db.Editions.FindAsync([editionId], ct);
                if (edition != null)
                {
                    edition.CoverPath = storagePath;
                }

                _logger.LogInformation("Saved cover for edition {EditionId}", editionId);
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to copy cover from {CoverPath}", coverPath);
            }
        }
    }

    private async Task IndexChaptersAsync(Guid editionId, Guid siteId, string language, CancellationToken ct)
    {
        var edition = await _db.Editions
            .Include(e => e.Chapters)
            .Include(e => e.EditionAuthors)
                .ThenInclude(ea => ea.Author)
            .FirstOrDefaultAsync(e => e.Id == editionId, ct);

        if (edition is null)
            return;

        var searchLang = language switch
        {
            "uk" => SearchLanguage.Uk,
            "en" => SearchLanguage.En,
            _ => SearchLanguage.Auto
        };

        var authors = string.Join(", ", edition.EditionAuthors.OrderBy(ea => ea.Order).Select(ea => ea.Author.Name));

        var documents = edition.Chapters.Select(chapter => new IndexDocument(
            Id: chapter.Id.ToString(),
            Title: chapter.Title,
            Content: chapter.PlainText,
            Language: searchLang,
            SiteId: siteId,
            Metadata: new Dictionary<string, object>
            {
                ["chapterId"] = chapter.Id,
                ["chapterSlug"] = chapter.Slug ?? string.Empty,
                ["chapterTitle"] = chapter.Title,
                ["chapterNumber"] = chapter.ChapterNumber,
                ["editionId"] = edition.Id,
                ["editionSlug"] = edition.Slug,
                ["editionTitle"] = edition.Title,
                ["language"] = edition.Language,
                ["authors"] = authors,
                ["coverPath"] = edition.CoverPath ?? string.Empty
            }
        )).ToList();

        if (documents.Count > 0)
        {
            await _searchIndexer.IndexBatchAsync(documents, ct);
            _logger.LogInformation("Indexed {Count} chapters for edition {EditionId}", documents.Count, editionId);
        }
    }

    private static string SanitizeText(string? text)
        => text?.Replace("\0", "") ?? "";
}
