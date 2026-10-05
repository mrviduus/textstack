using System.Security.Cryptography;
using Application.Collections;
using Application.ReadingTracking;
using System.Text.Json;
using Application.Common.Interfaces;
using Application.Entitlements;
using Contracts.UserBooks;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class UserBookService(IAppDbContext db, IFileStorageService storage, IEntitlementResolver entitlements)
{
    public async Task<(UploadUserBookResponse? Response, string? Error)> UploadAsync(
        Guid userId, Stream fileStream, string fileName, string? title, string? language, CancellationToken ct)
    {
        // Detect format
        var format = DetectFormat(fileName);
        if (format == BookFormat.Other)
            return (null, "Unsupported file format. Only EPUB and PDF are supported.");

        // An uploaded form file is seekable and its length known, so the quota is checked here
        // against that length before a byte of it is read, and the file is then streamed straight
        // to storage. ponytail: a non-seekable stream is buffered first; no caller passes one today.
        await using var buffered = fileStream.CanSeek ? null : new MemoryStream();
        if (buffered is not null)
        {
            await fileStream.CopyToAsync(buffered, ct);
            fileStream = buffered;
        }

        var (_, quotaError) = await CheckQuotaAsync(userId, fileStream.Length, ct);
        if (quotaError is not null)
            return (null, quotaError);

        // Truncated-PDF guard: a multipart can be well-formed while the PDF inside is
        // half-downloaded (valid %PDF- header, no startxref/%%EOF tail). Reject here so
        // we never create a book row that's doomed to fail at ingestion. O(header+tail).
        if (format == BookFormat.Pdf && !await PdfUploadSanity.LooksLikeCompletePdfAsync(fileStream, ct))
        {
            return (null, "This PDF looks incomplete or corrupted — if you just downloaded it, wait for the download to finish and try again.");
        }

        return await CreateBookAsync(
            userId,
            content: fileStream,
            originalFileName: fileName,
            storedFileName: $"original{Path.GetExtension(fileName)}",
            format: format,
            title: title ?? TitleFromFileName(fileName),
            author: null,
            language: language ?? "en",
            sourceUrl: null,
            isClip: false,
            ct);
    }

    /// <summary>
    /// "Send to TextStack" receiver: persists already-clean article HTML as a private clip
    /// (UserBook with <c>IsClip=true</c>, <see cref="BookFormat.Html"/>) reusing the same
    /// upload plumbing. NEVER creates Work/Edition/Chapter rows or touches the SSG path.
    /// </summary>
    public async Task<(UploadUserBookResponse? Response, string? Error)> ClipAsync(
        Guid userId, ClipRequest req, CancellationToken ct)
    {
        using var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(req.Html));

        return await CreateBookAsync(
            userId,
            content: ms,
            // Worker uses OriginalFileName as the extraction request FileName, so it must
            // carry .html for the registry to resolve HtmlTextExtractor.
            originalFileName: "original.html",
            storedFileName: "original.html",
            format: BookFormat.Html,
            title: req.Title,
            author: req.Author,
            language: req.Language ?? "en",
            sourceUrl: req.SourceUrl,
            isClip: true,
            ct);
    }

    /// <summary>
    /// Shared body for <see cref="UploadAsync"/> and <see cref="ClipAsync"/>: quota check,
    /// slug gen + collision, create UserBook + UserBookFile + UserIngestionJob, storage save,
    /// SHA256, quota update. <paramref name="content"/> position is reset internally.
    /// </summary>
    private async Task<(UploadUserBookResponse? Response, string? Error)> CreateBookAsync(
        Guid userId, Stream content, string originalFileName, string storedFileName,
        BookFormat format, string title, string? author, string language, string? sourceUrl,
        bool isClip, CancellationToken ct)
    {
        var fileSize = content.Length;
        var (user, quotaError) = await CheckQuotaAsync(userId, fileSize, ct);
        if (user is null)
            return (null, quotaError);

        content.Position = 0;
        var sha256 = await ComputeSha256Async(content, ct);

        var userBookId = Guid.NewGuid();
        var slug = SlugGenerator.GenerateSlug(title);

        var existingSlug = await db.UserBooks
            .Where(b => b.UserId == userId && b.Slug == slug)
            .Select(b => b.Slug)
            .FirstOrDefaultAsync(ct);
        if (existingSlug is not null)
            // Suffix with the (globally unique) book id, NOT a second-resolution
            // timestamp: two same-title saves within the same second would otherwise
            // collide on the (UserId, Slug) unique index and 500 on SaveChangesAsync.
            slug = $"{slug}-{userBookId.ToString("N")[..8]}";

        var userBook = new UserBook
        {
            Id = userBookId,
            UserId = userId,
            Title = title,
            Slug = slug,
            Language = language,
            Author = author,
            Status = UserBookStatus.Processing,
            SourceUrl = sourceUrl,
            IsClip = isClip,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };

        content.Position = 0;
        var storagePath = await storage.SaveUserFileAsync(userId, userBookId, storedFileName, content, ct);

        var userBookFile = new UserBookFile
        {
            Id = Guid.NewGuid(),
            UserBookId = userBookId,
            OriginalFileName = originalFileName,
            StoragePath = storagePath,
            Format = format,
            Sha256 = sha256,
            FileSize = fileSize,
            UploadedAt = DateTimeOffset.UtcNow
        };

        var job = new UserIngestionJob
        {
            Id = Guid.NewGuid(),
            UserBookId = userBookId,
            UserBookFileId = userBookFile.Id,
            Status = JobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        user.StorageUsedBytes += fileSize;

        db.UserBooks.Add(userBook);
        db.UserBookFiles.Add(userBookFile);
        db.UserIngestionJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return (new UploadUserBookResponse(
            userBookId, job.Id, UserBookStatus.Processing.ToString(), format == BookFormat.Pdf), null);
    }

    /// <summary>
    /// Storage and book-count limits of the user's tier for a file of <paramref name="fileSize"/>
    /// bytes. Needs only the size, so an upload is checked before it is read.
    /// </summary>
    private async Task<(User? User, string? Error)> CheckQuotaAsync(Guid userId, long fileSize, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
            return (null, "User not found");

        var allowed = entitlements.Resolve(user);

        if (user.StorageUsedBytes + fileSize > allowed.StorageLimitBytes)
            return (null, $"Storage limit exceeded. Used: {user.StorageUsedBytes}, Limit: {allowed.StorageLimitBytes}");

        if (allowed.MaxBooks is { } maxBooks)
        {
            var bookCount = await db.UserBooks.CountAsync(b => b.UserId == userId, ct);
            if (bookCount >= maxBooks)
                return (null, maxBooks == 1
                    ? "Guest accounts can upload 1 book. Sign up for more."
                    : $"Book limit reached ({maxBooks}).");
        }

        return (user, null);
    }

    /// <summary>
    /// Lists the user's books. <paramref name="shelf"/>="readlater" returns only clips
    /// (the Read later shelf); absent/other returns only non-clips (the Books tab) so clips
    /// never pollute the normal library. <paramref name="status"/>="unread" filters IsRead==false.
    /// </summary>
    public async Task<IReadOnlyList<UserBookListDto>> GetBooksAsync(
        Guid userId, CancellationToken ct, string? shelf = null, string? status = null)
    {
        var readLater = string.Equals(shelf, "readlater", StringComparison.OrdinalIgnoreCase);

        var query = db.UserBooks
            .Where(b => b.UserId == userId && b.TakedownAt == null)
            .Where(b => b.IsClip == readLater);

        if (string.Equals(status, "unread", StringComparison.OrdinalIgnoreCase))
            query = query.Where(b => !b.IsRead);

        var books = await query
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Slug,
                b.Language,
                b.Author,
                b.Description,
                b.CoverPath,
                b.Genre,
                b.Status,
                b.ErrorMessage,
                ChapterCount = b.Chapters.Count,
                b.TotalWordCount,
                b.CreatedAt,
                b.CompletedAt,
                b.ProgressPercent,
                b.ProgressUpdatedAt,
                b.ProgressChapterSlug,
                b.ProgressLocator,
                b.ProgressPositionJson,
                b.ProgressClientUpdatedAt,
                b.Tags,
                b.SuggestedTags,
                b.SourceUrl,
                b.IsClip,
                b.IsRead,
                b.ReadAt,
                // Correlated EXISTS — folds to SQL, no Include needed.
                HasOriginalPdf = b.BookFiles.Any(f => f.Format == BookFormat.Pdf)
            })
            .ToListAsync(ct);

        return books.Select(b => new UserBookListDto(
            b.Id,
            b.Title,
            b.Slug,
            b.Language,
            b.Author,
            b.Description,
            b.CoverPath,
            b.Genre,
            b.Status.ToString(),
            b.ErrorMessage,
            b.ChapterCount,
            b.TotalWordCount,
            b.CreatedAt,
            b.CompletedAt,
            b.ProgressPercent,
            b.ProgressUpdatedAt,
            b.ProgressChapterSlug,
            b.Tags ?? [],
            b.SuggestedTags ?? [],
            b.SourceUrl,
            b.IsClip,
            b.IsRead,
            b.ReadAt,
            b.HasOriginalPdf,
            b.ProgressLocator,
            b.ProgressPositionJson,
            b.ProgressClientUpdatedAt
        )).ToList();
    }

    /// <summary>Manually flip a book's read state (Read later shelf). Owner-scoped.</summary>
    public async Task<(bool Success, string? Error)> SetReadAsync(
        Guid userId, Guid bookId, bool isRead, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(
            b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null, ct);
        if (book is null)
            return (false, "Book not found");

        book.IsRead = isRead;
        book.ReadAt = isRead ? DateTimeOffset.UtcNow : null;
        book.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<UserBookDetailDto?> GetBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Where(b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Slug,
                b.Language,
                b.Author,
                b.Description,
                b.CoverPath,
                b.Genre,
                b.PublishedYear,
                b.TotalWordCount,
                b.Status,
                b.ErrorMessage,
                b.TocJson,
                b.CreatedAt,
                b.UpdatedAt,
                b.CompletedAt,
                b.MetadataEnrichmentStatus,
                b.SourceUrl,
                HasOriginalPdf = b.BookFiles.Any(f => f.Format == BookFormat.Pdf),
                // Size of the file /me/books/{id}/file would serve — same "newest
                // upload, any format" pick as the endpoint. Correlated subquery on
                // the join that is already here, not a second round trip.
                OriginalFileBytes = b.BookFiles
                    .OrderByDescending(f => f.UploadedAt)
                    .Select(f => (long?)f.FileSize)
                    .FirstOrDefault(),
                Chapters = b.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new UserChapterSummaryDto(
                        c.Id, c.ChapterNumber, c.Slug, c.Title, c.WordCount, c.SourceStartPage))
                    .ToList()
            })
            .FirstOrDefaultAsync(ct);

        if (book is null)
            return null;

        IReadOnlyList<TocEntryDto>? toc = null;
        if (!string.IsNullOrEmpty(book.TocJson))
        {
            try
            {
                toc = JsonSerializer.Deserialize<List<TocEntryDto>>(book.TocJson, Common.JsonDefaults.Options);
            }
            catch (JsonException)
            {
                // Malformed ToC JSON — return null toc
            }
        }

        return new UserBookDetailDto(
            book.Id,
            book.Title,
            book.Slug,
            book.Language,
            book.Author,
            book.Description,
            book.CoverPath,
            book.Genre,
            book.PublishedYear,
            book.TotalWordCount,
            book.Status.ToString(),
            book.ErrorMessage,
            book.Chapters,
            toc,
            book.CreatedAt,
            book.UpdatedAt,
            book.CompletedAt,
            book.HasOriginalPdf,
            book.MetadataEnrichmentStatus.ToString(),
            book.OriginalFileBytes,
            book.SourceUrl
        );
    }

    public async Task<UserChapterDto?> GetChapterBySlugAsync(Guid userId, Guid bookId, string slug, CancellationToken ct)
    {
        var chapter = await db.UserChapters
            .Where(c => c.UserBook.UserId == userId && c.UserBookId == bookId && c.Slug == slug && c.UserBook.TakedownAt == null)
            .Select(c => new
            {
                c.Id,
                c.ChapterNumber,
                c.Slug,
                c.Title,
                c.Html,
                c.WordCount,
                c.UserBookId
            })
            .FirstOrDefaultAsync(ct);

        if (chapter is null)
            return null;

        // Both neighbours in one round trip.
        var neighbours = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId
                && (c.ChapterNumber == chapter.ChapterNumber - 1 || c.ChapterNumber == chapter.ChapterNumber + 1))
            .Select(c => new UserChapterNavDto(c.ChapterNumber, c.Slug, c.Title))
            .ToListAsync(ct);
        var prev = neighbours.FirstOrDefault(n => n.ChapterNumber < chapter.ChapterNumber);
        var next = neighbours.FirstOrDefault(n => n.ChapterNumber > chapter.ChapterNumber);

        return new UserChapterDto(
            chapter.Id,
            chapter.ChapterNumber,
            chapter.Slug,
            chapter.Title,
            chapter.Html,
            chapter.WordCount,
            prev,
            next
        );
    }

    public async Task<(bool Success, string? Error)> DeleteAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Include(b => b.BookFiles)
            .FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);

        if (book is null)
            return (false, "Book not found");

        // Calculate total file size to deduct from user quota
        var totalFileSize = book.BookFiles.Sum(f => f.FileSize);

        // Delete files from storage
        await storage.DeleteUserBookDirectoryAsync(userId, bookId, ct);

        // Update user storage quota
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is not null)
            user.StorageUsedBytes = Math.Max(0, user.StorageUsedBytes - totalFileSize);

        // Delete from database (cascade will handle related entities; collection rows have no FK)
        await CollectionService.RemoveFromAllCollectionsAsync(db, null, bookId, "userbook", ct);
        db.UserBooks.Remove(book);
        await db.SaveChangesAsync(ct);

        return (true, null);
    }

    public async Task<(bool Success, string? Error)> CancelAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);
        if (book is null)
            return (false, "Book not found");

        if (book.Status != UserBookStatus.Processing)
            return (false, "Only processing books can be cancelled");

        // Cancel any active job
        var job = await db.UserIngestionJobs
            .Where(j => j.UserBookId == bookId && (j.Status == JobStatus.Queued || j.Status == JobStatus.Processing))
            .FirstOrDefaultAsync(ct);
        if (job is not null)
        {
            job.Status = JobStatus.Failed;
            job.Error = "Cancelled by user";
            job.FinishedAt = DateTimeOffset.UtcNow;
        }

        book.Status = UserBookStatus.Failed;
        book.ErrorMessage = "Cancelled by user";
        book.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> RetryAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Include(b => b.BookFiles)
            .FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null, ct);

        if (book is null)
            return (false, "Book not found");

        // Allow retrying Failed (original behaviour) AND re-extracting Ready
        // books — extractor improvements (e.g. bullet paragraph split, TOC
        // drop) should be reachable without a delete+reupload roundtrip.
        // Processing is excluded so we don't queue duplicate jobs.
        if (book.Status != UserBookStatus.Failed && book.Status != UserBookStatus.Ready)
            return (false, $"Cannot reprocess book in status {book.Status}");

        var bookFile = book.BookFiles.FirstOrDefault();
        if (bookFile is null)
            return (false, "No source file found");

        // Verify the backing file is actually still on disk. Without this
        // guard the worker would happily queue a job that's destined to
        // fail at extraction time and leave the book stuck in Processing.
        if (!await storage.ExistsAsync(bookFile.StoragePath, ct))
            return (false, "Source file is missing from storage");

        // Create new ingestion job
        var job = new UserIngestionJob
        {
            Id = Guid.NewGuid(),
            UserBookId = bookId,
            UserBookFileId = bookFile.Id,
            Status = JobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        // Reset book status
        book.Status = UserBookStatus.Processing;
        book.ErrorMessage = null;
        book.UpdatedAt = DateTimeOffset.UtcNow;

        db.UserIngestionJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return (true, null);
    }

    public async Task<StorageQuotaDto> GetStorageQuotaAsync(Guid userId, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);

        // An absent user resolves through the same path as a real one, so the quota endpoint can
        // never disagree with what an upload would actually enforce.
        var resolved = user is not null
            ? entitlements.Resolve(user)
            : entitlements.Resolve(new User { Email = string.Empty });

        var usedBytes = user?.StorageUsedBytes ?? 0;
        var limit = resolved.StorageLimitBytes;
        var percent = limit > 0 ? (double)usedBytes / limit * 100 : 0;

        var booksUsed = user is not null
            ? await db.UserBooks.CountAsync(b => b.UserId == userId, ct)
            : 0;

        return new StorageQuotaDto(
            usedBytes, limit, Math.Round(percent, 2),
            resolved.Tier.ToString(), resolved.MaxBooks, booksUsed, resolved.MaxSingleUploadBytes);
    }

    public async Task<UserBookProgressDto?> GetProgressAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Where(b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null)
            .Select(b => new { b.ProgressChapterSlug, b.ProgressLocator, b.ProgressPercent, b.ProgressUpdatedAt, b.ProgressPositionJson, b.ProgressClientUpdatedAt })
            .FirstOrDefaultAsync(ct);

        // Page-based (PDF "Original layout", ADR-012) progress has no chapter — the
        // position lives in ProgressLocator ("page:N"). So progress exists when EITHER
        // a chapter slug OR a locator is recorded; only a truly empty row 404s.
        if (book is null || (book.ProgressChapterSlug is null && book.ProgressLocator is null))
            return null;

        return new UserBookProgressDto(
            book.ProgressChapterSlug,
            book.ProgressLocator,
            book.ProgressPercent,
            book.ProgressUpdatedAt,
            book.ProgressPositionJson,
            book.ProgressClientUpdatedAt
        );
    }

    public async Task<(bool Success, string? Error)> UpsertProgressAsync(
        Guid userId, Guid bookId, UpsertUserBookProgressRequest request, CancellationToken ct)
    {
        // The chapter-slug check rides along in the same read (one round trip, not two).
        var row = await db.UserBooks
            .Where(b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null)
            .Select(b => new { Book = b, ChapterKnown = b.Chapters.Any(c => c.Slug == request.ChapterSlug) })
            .FirstOrDefaultAsync(ct);
        if (row is null)
            return (false, "Book not found");
        var book = row.Book;

        // The position must come from the coordinate space that already owns this
        // book, or say plainly that it is moving between spaces. An uploaded PDF
        // read in Original layout stores `page:<n>`; the reflow reader stores
        // `scroll:<slug>:<offset>`. Installed builds write the second one on every
        // reader close whatever is on screen, which is how `page:16` at 14% became
        // `scroll:2-the-mom-test:0` at 4%. See LocatorSpace for why this is not a
        // ranking and not a timestamp.
        //
        // A refusal drops the whole write — the percent came out of the same wrong
        // snapshot as the locator.
        if (!LocatorSpace.MayReplace(book.ProgressLocator, request.Locator, request.LocatorKind))
        {
            // Reported, not silent. This used to return (true, null) on the reasoning that an old
            // client cannot act on an error and would only retry into it — true of a reader's app,
            // and exactly wrong for an assistant writing progress over MCP, which will report
            // "recorded" to a person on the strength of a 200 that recorded nothing. A refusal here
            // means the write carried a position in a coordinate space the stored one is not in.
            return (false, "This book's position is stored in a different coordinate space. "
                         + "Declare locatorKind to move it between them.");
        }

        // Validated, not trusted. This was a raw assignment, so an assistant that invented a chapter
        // slug had it stored verbatim — and every later read would resolve it to nothing. The
        // bookmark path in this same file has always checked (AddBookmarkAsync); progress never did.
        // Null stays legal: a chapterless PDF in Original layout has a page, not a chapter.
        if (!string.IsNullOrWhiteSpace(request.ChapterSlug) && !row.ChapterKnown)
            return (false, $"No chapter '{request.ChapterSlug}' in this book");

        // Last-write-wins on the CLIENT clock only, the same rule as catalog progress
        // (UserDataEndpoints.UpsertProgress → ProgressClock). Without it uploads were
        // "newest arrival wins": a phone coming back online with an older offline write
        // overwrote what another device had recorded since. A write with no timestamp
        // (MCP, mark-as-finished, older builds) always goes through. A stale write is
        // answered as accepted, like the catalog path — the stored row is newer, which
        // is exactly what the caller should resume from.
        var now = DateTimeOffset.UtcNow;
        if (ProgressClock.IsStale(request.UpdatedAt, book.ProgressClientUpdatedAt, now))
            return (true, null);

        book.ProgressChapterSlug = request.ChapterSlug;
        book.ProgressLocator = request.Locator;
        // Assigned, never merged — see ReaderPosition. Reached only after MayReplace
        // has accepted the write, so a refusal leaves the stored position alone too.
        book.ProgressPositionJson = ReaderPosition.ToStore(request.PositionJson, request.Locator);
        // A null Percent means "I know where the reader is, but not how far
        // through the book" — the client could not compute a book-wide value
        // because the chapter list had not resolved (every save made offline,
        // and the first saves of a cold open). Keep the last known good percent
        // rather than nulling the column, and never let the client substitute a
        // chapter fraction, which reaches 1.0 at the bottom of every chapter.
        //
        // And only when the caller declared what the number is a fraction of. An
        // older build sending a chapter fraction is indistinguishable from a
        // correct write by inspection, so an undeclared unit means the position is
        // saved and the number is left alone. See ProgressUnit.
        if (request.Percent.HasValue && ProgressUnit.IsTrusted(request.PercentUnit))
            book.ProgressPercent = request.Percent;
        // Two clocks, two columns. ProgressUpdatedAt is the server's, always — it once
        // held `request.UpdatedAt ?? UtcNow`, and a gate comparing a client stamp with a
        // column of mixed clocks silently dropped good writes. The client's stamp lives
        // in ProgressClientUpdatedAt and is compared only with itself (the gate above).
        // Assigned, not max-ed: a write with no timestamp clears it, same as catalog.
        book.ProgressUpdatedAt = now;
        book.ProgressClientUpdatedAt = ProgressClock.Clamp(request.UpdatedAt, now);

        if (request.Percent is >= 0.99 && ProgressUnit.IsTrusted(request.PercentUnit))
        {
            book.CompletedAt ??= DateTimeOffset.UtcNow;
            // Auto-mark clips read once finished so they leave the Unread shelf.
            if (!book.IsRead)
            {
                book.IsRead = true;
                book.ReadAt = DateTimeOffset.UtcNow;
            }
        }

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<IReadOnlyList<UserBookBookmarkDto>> GetBookmarksAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        return await db.UserBookBookmarks
            .Where(b => b.UserBook.UserId == userId && b.UserBookId == bookId && b.UserBook.TakedownAt == null)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new UserBookBookmarkDto(
                b.Id,
                b.ChapterId,
                // Page bookmarks (chapterless PDF, ADR-012) have no chapter — don't deref
                // the nav; return a null slug and let Locator ("page:N") be the anchor.
                b.Chapter != null ? b.Chapter.Slug : null,
                b.Locator,
                b.Title,
                b.CreatedAt
            ))
            .ToListAsync(ct);
    }

    public async Task<(UserBookBookmarkDto? Bookmark, string? Error)> CreateBookmarkAsync(
        Guid userId, Guid bookId, CreateUserBookBookmarkRequest request, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId && b.TakedownAt == null, ct);
        if (book is null)
            return (null, "Book not found");

        if (string.IsNullOrWhiteSpace(request.Locator))
            return (null, "Locator is required");

        // Chapter is optional: a page bookmark on a chapterless PDF ("Original layout",
        // ADR-012) carries only a page Locator. When a ChapterId IS supplied it must resolve
        // to a chapter of this book (the reflow/EPUB path).
        UserChapter? chapter = null;
        if (request.ChapterId is { } chapterId)
        {
            chapter = await db.UserChapters.FirstOrDefaultAsync(c => c.UserBookId == bookId && c.Id == chapterId, ct);
            if (chapter is null)
                return (null, "Chapter not found");
        }

        var bookmark = new UserBookBookmark
        {
            Id = Guid.NewGuid(),
            UserBookId = bookId,
            ChapterId = request.ChapterId,
            Locator = request.Locator,
            Title = request.Title,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.UserBookBookmarks.Add(bookmark);
        await db.SaveChangesAsync(ct);

        return (new UserBookBookmarkDto(
            bookmark.Id,
            bookmark.ChapterId,
            chapter?.Slug,
            bookmark.Locator,
            bookmark.Title,
            bookmark.CreatedAt
        ), null);
    }

    public async Task<(bool Success, string? Error)> DeleteBookmarkAsync(
        Guid userId, Guid bookId, Guid bookmarkId, CancellationToken ct)
    {
        var bookmark = await db.UserBookBookmarks
            .FirstOrDefaultAsync(b => b.UserBook.UserId == userId && b.UserBookId == bookId && b.Id == bookmarkId, ct);

        if (bookmark is null)
            return (false, "Bookmark not found");

        db.UserBookBookmarks.Remove(bookmark);
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    /// <summary>
    /// Placeholder title from the upload's filename, until ingestion reads real metadata.
    /// Cleaned, because shadow-library filenames carry "(z-library.sk, 1lib.sk)" and a PDF
    /// with no metadata title keeps this one forever.
    /// </summary>
    public static string TitleFromFileName(string fileName)
    {
        var raw = Path.GetFileNameWithoutExtension(fileName);
        var cleaned = global::TextStack.Extraction.Utilities.BookTitleCleaner.Clean(raw);
        return string.IsNullOrWhiteSpace(cleaned) ? raw : cleaned;
    }

    private static BookFormat DetectFormat(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".epub" => BookFormat.Epub,
            ".pdf" => BookFormat.Pdf,
            _ => BookFormat.Other
        };
    }

    private static async Task<string> ComputeSha256Async(Stream stream, CancellationToken ct)
    {
        using var sha256 = SHA256.Create();
        var hash = await sha256.ComputeHashAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
