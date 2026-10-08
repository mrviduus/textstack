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
    public void NeedsPageCount_PdfWithoutCount_Selected(UserBookStatus status) =>
        Assert.True(Needs(Book(status)));

    [Fact]
    public void NeedsPageCount_Processing_NotSelected() =>
        Assert.False(Needs(Book(UserBookStatus.Processing)));

    [Fact]
    public void NeedsPageCount_AlreadyCounted_NotSelected() =>
        Assert.False(Needs(Book(UserBookStatus.Failed, pages: 12)));

    [Fact]
    public void NeedsPageCount_Epub_NotSelected() =>
        Assert.False(Needs(Book(UserBookStatus.Ready, BookFormat.Epub)));
}
