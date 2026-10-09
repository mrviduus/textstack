using Application.Common.Interfaces;
using Application.UserBooks;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Moq;

namespace TextStack.UnitTests;

// GetBookAsync mapping of the two "Original layout" contract fields:
//   • UserBookDetailDto.HasOriginalPdf  — true iff a stored file is BookFormat.Pdf
//   • UserChapterSummaryDto.SourceStartPage — 1-based physical PDF page per chapter
// Backed by the same List<T>-backed Moq IAppDbContext used by the clip tests.
public class UserBookDetailMappingTests
{
    private sealed class Harness
    {
        public List<UserBook> UserBooks { get; } = [];
        public List<UserChapter> UserChapters { get; } = [];
        public List<UserBookFile> UserBookFiles { get; } = [];
        public UserBookService Service { get; }

        public Harness()
        {
            var db = new Mock<IAppDbContext>();
            db.Setup(x => x.UserBooks).Returns(() => FakeSet(UserBooks).Object);
            db.Setup(x => x.UserChapters).Returns(() => FakeSet(UserChapters).Object);
            db.Setup(x => x.UserBookFiles).Returns(() => FakeSet(UserBookFiles).Object);
            var storage = new Mock<IFileStorageService>();
            Service = new UserBookService(db.Object, storage.Object, TestEntitlements.Resolver);
        }
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        return set;
    }

    private static UserBook SeedBook(Harness h, Guid userId, Guid bookId, BookFormat? fileFormat,
        params (int Number, int? StartPage)[] chapters)
    {
        var book = new UserBook
        {
            Id = bookId,
            UserId = userId,
            Title = "T",
            Slug = "t",
            Language = "en",
            Status = UserBookStatus.Ready,
        };
        foreach (var (num, start) in chapters)
        {
            var ch = new UserChapter
            {
                Id = Guid.NewGuid(),
                UserBookId = bookId,
                ChapterNumber = num,
                Slug = $"ch-{num}",
                Title = $"Chapter {num}",
                Html = "<p>x</p>",
                PlainText = "x",
                WordCount = 10,
                SourceStartPage = start,
            };
            book.Chapters.Add(ch);
            h.UserChapters.Add(ch);
        }
        if (fileFormat is { } fmt)
        {
            var file = new UserBookFile
            {
                Id = Guid.NewGuid(),
                UserBookId = bookId,
                OriginalFileName = "original" + (fmt == BookFormat.Pdf ? ".pdf" : ".epub"),
                StoragePath = "path",
                Format = fmt,
            };
            book.BookFiles.Add(file);
            h.UserBookFiles.Add(file);
        }
        h.UserBooks.Add(book);
        return book;
    }

    // PDF-2: the detail DTO carries the stored PDF page count.
    [Fact]
    [Trait("Rule", "PDF-2")]
    public async Task GetBookAsync_PageCountStored_ReturnedInDto()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var bookId = Guid.NewGuid();
        SeedBook(h, userId, bookId, BookFormat.Pdf, (1, 1)).PageCount = 15;

        var dto = await h.Service.GetBookAsync(userId, bookId, CancellationToken.None);

        Assert.Equal(15, dto!.PageCount);
    }

    [Fact]
    public async Task GetBookAsync_PdfOriginal_HasOriginalPdfTrue()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var bookId = Guid.NewGuid();
        SeedBook(h, userId, bookId, BookFormat.Pdf, (1, 1), (2, 16));

        var dto = await h.Service.GetBookAsync(userId, bookId, CancellationToken.None);

        Assert.NotNull(dto);
        Assert.True(dto!.HasOriginalPdf);
    }

    [Fact]
    public async Task GetBookAsync_EpubOriginal_HasOriginalPdfFalse()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var bookId = Guid.NewGuid();
        SeedBook(h, userId, bookId, BookFormat.Epub, (1, null));

        var dto = await h.Service.GetBookAsync(userId, bookId, CancellationToken.None);

        Assert.NotNull(dto);
        Assert.False(dto!.HasOriginalPdf);
    }

    [Fact]
    public async Task GetBooksAsync_PdfOriginal_ListDtoHasOriginalPdfTrue()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        SeedBook(h, userId, Guid.NewGuid(), BookFormat.Pdf, (1, 1));

        var list = await h.Service.GetBooksAsync(userId, CancellationToken.None);

        var dto = Assert.Single(list);
        Assert.True(dto.HasOriginalPdf);
    }

    [Fact]
    public async Task GetBooksAsync_EpubOriginal_ListDtoHasOriginalPdfFalse()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        SeedBook(h, userId, Guid.NewGuid(), BookFormat.Epub, (1, null));

        var list = await h.Service.GetBooksAsync(userId, CancellationToken.None);

        var dto = Assert.Single(list);
        Assert.False(dto.HasOriginalPdf);
    }

    [Fact]
    public async Task GetBookAsync_PdfChapters_PropagateSourceStartPage()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var bookId = Guid.NewGuid();
        SeedBook(h, userId, bookId, BookFormat.Pdf, (1, 1), (2, 16), (3, 31));

        var dto = await h.Service.GetBookAsync(userId, bookId, CancellationToken.None);

        Assert.NotNull(dto);
        Assert.Equal([1, 16, 31], dto!.Chapters.Select(c => c.SourceStartPage).ToArray());
    }

    [Fact]
    public async Task GetBookAsync_NonPdfChapters_SourceStartPageNull()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var bookId = Guid.NewGuid();
        SeedBook(h, userId, bookId, BookFormat.Epub, (1, null), (2, null));

        var dto = await h.Service.GetBookAsync(userId, bookId, CancellationToken.None);

        Assert.NotNull(dto);
        Assert.All(dto!.Chapters, c => Assert.Null(c.SourceStartPage));
    }
}
