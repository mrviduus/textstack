using Application.UserBooks;
using Domain.Entities;
using Domain.Enums;

namespace TextStack.UnitTests;

// Review r4 of #780: a failed PDF upload still opens in the Original layout, so the
// backfill-pdf-page-counts CLI selects it too — not only Ready ones.
public class PdfPageCountBackfillTests
{
    private static readonly Func<UserBook, bool> Needs = PdfPageCountBackfill.NeedsPageCount.Compile();

    private static UserBook Book(UserBookStatus status, BookFormat format = BookFormat.Pdf, int? pages = null) => new()
    {
        Id = Guid.NewGuid(),
        Title = "t",
        Slug = "t",
        Language = "en",
        Status = status,
        PageCount = pages,
        BookFiles = [new UserBookFile { StoragePath = "p", Format = format, OriginalFileName = "f", Sha256 = "s" }],
    };

    [Theory]
    [InlineData(UserBookStatus.Ready)]
    [InlineData(UserBookStatus.Failed)]
    [InlineData(UserBookStatus.Processing)] // review r9: opens in Original layout too
    public void NeedsPageCount_PdfWithoutCount_Selected(UserBookStatus status) =>
        Assert.True(Needs(Book(status)));

    [Fact]
    public void NeedsPageCount_AlreadyCounted_NotSelected() =>
        Assert.False(Needs(Book(UserBookStatus.Failed, pages: 12)));

    [Fact]
    public void NeedsPageCount_Epub_NotSelected() =>
        Assert.False(Needs(Book(UserBookStatus.Ready, BookFormat.Epub)));

    // Review r6 of #780: one book's failure is logged and skipped; the rest are written as it goes.
    [Fact]
    public async Task RunAsync_OneThrowsOneUnreadable_OthersWrittenFailuresLogged()
    {
        var (ok1, boom, unreadable, ok2) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var written = new Dictionary<Guid, int>();
        var log = new List<string>();

        var (updated, failed) = await PdfPageCountBackfill.RunAsync(
            [(ok1, "a"), (boom, "b"), (unreadable, "c"), (ok2, "d")],
            path => path switch { "b" => throw new IOException("disk"), "c" => null, _ => 7 },
            (id, pages) => { written[id] = pages; return Task.CompletedTask; },
            log.Add);

        Assert.Equal((2, 2), (updated, failed));
        Assert.Equal(new Dictionary<Guid, int> { [ok1] = 7, [ok2] = 7 }, written);
        Assert.Contains(log, l => l.Contains(boom.ToString()) && l.Contains("disk"));
        Assert.Contains(log, l => l.Contains(unreadable.ToString()));
    }

    [Fact]
    public async Task RunAsync_WriteThrows_CountedFailedLoopContinues()
    {
        var (bad, good) = (Guid.NewGuid(), Guid.NewGuid());
        var written = new List<Guid>();

        var (updated, failed) = await PdfPageCountBackfill.RunAsync(
            [(bad, "a"), (good, "b")],
            _ => 3,
            (id, _) =>
            {
                if (id == bad) throw new InvalidOperationException("db");
                written.Add(id);
                return Task.CompletedTask;
            },
            _ => { });

        Assert.Equal((1, 1), (updated, failed));
        Assert.Equal([good], written);
    }
}
