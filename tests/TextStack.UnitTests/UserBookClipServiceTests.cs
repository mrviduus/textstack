using Application.Common.Interfaces;
using Application.UserBooks;
using Contracts.UserBooks;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Moq;

namespace TextStack.UnitTests;

// ClipAsync over a Moq IAppDbContext whose sets are backed by List<T> (async LINQ via
// TestAsyncQueryable). The production AppDbContext can't load on EF InMemory (NpgsqlTsVector
// on Chapter), so we fake just the sets ClipAsync touches. The key assertion is the spec
// §1.7 invariant: a clip is a PRIVATE UserBook and MUST NEVER create Work/Edition/Chapter rows.
public class UserBookClipServiceTests
{
    private sealed class Harness
    {
        public List<User> Users { get; } = [];
        public List<UserBook> UserBooks { get; } = [];
        public List<UserBookFile> UserBookFiles { get; } = [];
        public List<UserIngestionJob> Jobs { get; } = [];
        public List<Work> Works { get; } = [];
        public List<Edition> Editions { get; } = [];
        public List<Chapter> Chapters { get; } = [];
        public Mock<IFileStorageService> Storage { get; } = new();
        public UserBookService Service { get; }

        public Harness()
        {
            Storage
                .Setup(s => s.SaveUserFileAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync((Guid uid, Guid bid, string name, Stream _, CancellationToken _) => $"users/{uid}/books/{bid}/{name}");

            var db = new Mock<IAppDbContext>();
            db.Setup(x => x.Users).Returns(() => FakeSet(Users).Object);
            db.Setup(x => x.UserBooks).Returns(() => FakeSet(UserBooks).Object);
            db.Setup(x => x.UserBookFiles).Returns(() => FakeSet(UserBookFiles).Object);
            db.Setup(x => x.UserIngestionJobs).Returns(() => FakeSet(Jobs).Object);
            db.Setup(x => x.Works).Returns(() => FakeSet(Works).Object);
            db.Setup(x => x.Editions).Returns(() => FakeSet(Editions).Object);
            db.Setup(x => x.Chapters).Returns(() => FakeSet(Chapters).Object);
            db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(0);

            Service = new UserBookService(db.Object, Storage.Object, TestEntitlements.Resolver);
        }

        public User SeedUser()
        {
            var u = new User { Id = Guid.NewGuid(), Email = "clip@test.dev", IsGuest = false, StorageUsedBytes = 0 };
            Users.Add(u);
            return u;
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
        set.Setup(m => m.Add(It.IsAny<T>())).Callback<T>(e => data.Add(e));
        return set;
    }

    private static ClipRequest SampleClip() => new(
        Title: "How Reading Builds Fluency",
        Author: "Jane Doe",
        SourceUrl: "https://example.com/article",
        Html: "<h1>How Reading Builds Fluency</h1><p>Real fluency comes from real books.</p>",
        Language: "en");

    [Fact]
    public async Task ClipAsync_ValidRequest_CreatesPrivateUserBookClip()
    {
        var h = new Harness();
        var user = h.SeedUser();

        var (response, error) = await h.Service.ClipAsync(user.Id, SampleClip(), CancellationToken.None);

        Assert.Null(error);
        Assert.NotNull(response);
        Assert.Equal("Processing", response!.Status);

        var book = Assert.Single(h.UserBooks);
        Assert.True(book.IsClip);
        Assert.Equal("https://example.com/article", book.SourceUrl);
        Assert.Equal("Jane Doe", book.Author);
        Assert.Equal("en", book.Language);

        var file = Assert.Single(h.UserBookFiles);
        Assert.Equal(BookFormat.Html, file.Format);
        // OriginalFileName must carry .html so the worker registry resolves HtmlTextExtractor.
        Assert.EndsWith(".html", file.OriginalFileName);

        Assert.Single(h.Jobs);
    }

    [Fact]
    public async Task ClipAsync_AnyClip_CreatesNoWorkOrEdition()
    {
        var h = new Harness();
        var user = h.SeedUser();

        await h.Service.ClipAsync(user.Id, SampleClip(), CancellationToken.None);

        // The locked constraint: clips are private UserBooks only — never the public path.
        Assert.Empty(h.Works);
        Assert.Empty(h.Editions);
        Assert.Empty(h.Chapters);
    }

    [Fact]
    public async Task ClipAsync_MissingUser_ReturnsError()
    {
        var h = new Harness();

        var (response, error) = await h.Service.ClipAsync(Guid.NewGuid(), SampleClip(), CancellationToken.None);

        Assert.Null(response);
        Assert.Equal("User not found", error);
    }

    [Fact]
    public async Task ClipAsync_StorageLimitExceeded_ReturnsError()
    {
        var h = new Harness();
        var user = h.SeedUser();
        user.StorageUsedBytes = TestEntitlements.FreeStorageBytes; // already full

        var (response, error) = await h.Service.ClipAsync(user.Id, SampleClip(), CancellationToken.None);

        Assert.Null(response);
        Assert.NotNull(error);
        Assert.Contains("Storage limit", error);
    }

    [Fact]
    public async Task ClipAsync_CountsAgainstStorageQuota()
    {
        var h = new Harness();
        var user = h.SeedUser();

        await h.Service.ClipAsync(user.Id, SampleClip(), CancellationToken.None);

        // A clip is a stored file; its bytes must be added to the user's quota.
        Assert.True(user.StorageUsedBytes > 0, "clip did not consume storage quota");
        var file = Assert.Single(h.UserBookFiles);
        Assert.Equal(user.StorageUsedBytes, file.FileSize);
    }

    // The UserBook.Title shows in the shelf + reader header. The backend stores it as TEXT
    // verbatim (it is NOT HTML), so the frontend is responsible for escaping it on render.
    // This test pins the contract: a script-y title is persisted raw, never executed/parsed here.
    [Fact]
    public async Task ClipAsync_HtmlTitle_StoredVerbatimAsText()
    {
        var h = new Harness();
        var user = h.SeedUser();
        var clip = new ClipRequest(
            Title: "<img src=x onerror=alert(1)>",
            Author: null,
            SourceUrl: "https://example.com/a",
            Html: "<h1>Body</h1><p>prose</p>",
            Language: "en");

        await h.Service.ClipAsync(user.Id, clip, CancellationToken.None);

        var book = Assert.Single(h.UserBooks);
        Assert.Equal("<img src=x onerror=alert(1)>", book.Title);
        Assert.True(book.IsClip);
    }

    // FB2 support was dropped — a .fb2 upload must resolve to BookFormat.Other and be rejected
    // up front with the EPUB/PDF-only message, before any storage or DB work happens.
    [Fact]
    public async Task UploadAsync_Fb2File_RejectedAsUnsupportedFormat()
    {
        var h = new Harness();
        var user = h.SeedUser();
        using var stream = new MemoryStream("<FictionBook/>"u8.ToArray());

        var (response, error) = await h.Service.UploadAsync(
            user.Id, stream, "book.fb2", title: null, language: "en", CancellationToken.None);

        Assert.Null(response);
        Assert.Equal("Unsupported file format. Only EPUB and PDF are supported.", error);
        Assert.Empty(h.UserBooks);
        Assert.Empty(h.UserBookFiles);
    }

    // S1a: a PDF upload is readable instantly (file stored at upload), so the
    // upload response carries HasOriginalPdf=true derived from the known format.
    // A structurally complete minimal PDF: %PDF- header + startxref + %%EOF trailer.
    // Uploads now run PdfUploadSanity.LooksLikeCompletePdf before creating a book row.
    private static byte[] CompletePdfBytes() =>
        "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\nstartxref\n9\n%%EOF"u8.ToArray();

    [Fact]
    public async Task UploadAsync_PdfFile_ResponseHasOriginalPdfTrue()
    {
        var h = new Harness();
        var user = h.SeedUser();
        using var stream = new MemoryStream(CompletePdfBytes());

        var (response, error) = await h.Service.UploadAsync(
            user.Id, stream, "book.pdf", title: null, language: "en", CancellationToken.None);

        Assert.Null(error);
        Assert.NotNull(response);
        Assert.True(response!.HasOriginalPdf);
    }

    // Prod incident: a PDF uploaded while the browser was still downloading it — valid
    // %PDF- header but no startxref/%%EOF tail. Must be rejected up front, no book/file rows.
    [Fact]
    public async Task UploadAsync_TruncatedPdf_RejectedNoBookRow()
    {
        var h = new Harness();
        var user = h.SeedUser();
        using var stream = new MemoryStream("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n(no trailer here)"u8.ToArray());

        var (response, error) = await h.Service.UploadAsync(
            user.Id, stream, "book.pdf", title: null, language: "en", CancellationToken.None);

        Assert.Null(response);
        Assert.Equal(
            "This PDF looks incomplete or corrupted — if you just downloaded it, wait for the download to finish and try again.",
            error);
        Assert.Empty(h.UserBooks);
        Assert.Empty(h.UserBookFiles);
        Assert.Empty(h.Jobs);
        Assert.Equal(0, user.StorageUsedBytes);
    }

    /// <summary>A seekable stream that knows its length but fails any read — proves nothing was read.</summary>
    private sealed class UnreadableStream(long length) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get; set; }
        public override int Read(byte[] buffer, int offset, int count) => throw new InvalidOperationException("read before the size check");
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => Position = offset;
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Theory]
    [InlineData("book.pdf")]
    [InlineData("book.epub")]
    public async Task UploadAsync_LargerThanRemainingQuota_RejectedBeforeReading(string fileName)
    {
        var h = new Harness();
        var user = h.SeedUser();
        user.StorageUsedBytes = TestEntitlements.FreeStorageBytes - 10;
        await using var stream = new UnreadableStream(length: 11);

        var (response, error) = await h.Service.UploadAsync(
            user.Id, stream, fileName, title: null, language: "en", CancellationToken.None);

        Assert.Null(response);
        Assert.StartsWith("Storage limit exceeded.", error);
        Assert.Empty(h.UserBooks);
        h.Storage.Verify(s => s.SaveUserFileAsync(
            It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UploadAsync_SeekableStream_HandedToStorageWithoutCopy()
    {
        var h = new Harness();
        var user = h.SeedUser();
        Stream? saved = null;
        h.Storage
            .Setup(s => s.SaveUserFileAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string>(), It.IsAny<Stream>(), It.IsAny<CancellationToken>()))
            .Callback((Guid _, Guid _, string _, Stream s, CancellationToken _) => saved = s)
            .ReturnsAsync("users/x/original.pdf");
        using var stream = new MemoryStream(CompletePdfBytes());

        var (_, error) = await h.Service.UploadAsync(
            user.Id, stream, "book.pdf", title: null, language: "en", CancellationToken.None);

        Assert.Null(error);
        Assert.Same(stream, saved);
        Assert.Equal(stream.Length, h.UserBookFiles.Single().FileSize);
    }

    [Fact]
    public async Task UploadAsync_EpubFile_ResponseHasOriginalPdfFalse()
    {
        var h = new Harness();
        var user = h.SeedUser();
        using var stream = new MemoryStream("epub-bytes"u8.ToArray());

        var (response, error) = await h.Service.UploadAsync(
            user.Id, stream, "book.epub", title: null, language: "en", CancellationToken.None);

        Assert.Null(error);
        Assert.NotNull(response);
        Assert.False(response!.HasOriginalPdf);
    }

    [Fact]
    public async Task SetReadAsync_ForeignBook_ReturnsErrorNotSilentSuccess()
    {
        var h = new Harness();
        var owner = h.SeedUser();
        var other = h.SeedUser();
        await h.Service.ClipAsync(owner.Id, SampleClip(), CancellationToken.None);
        var book = h.UserBooks[0];

        // A different user must not be able to flip read-state on someone else's clip.
        var (success, error) = await h.Service.SetReadAsync(other.Id, book.Id, true, CancellationToken.None);

        Assert.False(success);
        Assert.Equal("Book not found", error);
        Assert.False(book.IsRead);
    }

    [Fact]
    public async Task SetReadAsync_OwnBook_FlipsState()
    {
        var h = new Harness();
        var owner = h.SeedUser();
        await h.Service.ClipAsync(owner.Id, SampleClip(), CancellationToken.None);
        var book = h.UserBooks[0];

        var (success, error) = await h.Service.SetReadAsync(owner.Id, book.Id, true, CancellationToken.None);

        Assert.True(success);
        Assert.Null(error);
        Assert.True(book.IsRead);
        Assert.NotNull(book.ReadAt);
    }
}
