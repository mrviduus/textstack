using Application.UserBooks;
using Domain.Entities;
using Domain.Enums;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using Worker.Services;

namespace TextStack.UnitTests;

// PDF-2: a PDF upload's detail page shows its real page count, stored on UserBook.PageCount.
public class PdfPageCountTests
{
    private static ExtractionResult Result(int? pages) => new(
        SourceFormat.Pdf,
        new ExtractionMetadata(null, null, null, null, PageCount: pages),
        [], [],
        new ExtractionDiagnostics(TextSource.None, null, []));

    [Fact]
    public void PDF2_RecordExtractionFacts_StoresCountOnlyWhenKnown()
    {
        var job = new UserIngestionJob { UserBook = new UserBook { Title = "t", Slug = "t", Language = "en" } };

        UserIngestionService.RecordExtractionFacts(job, Result(42));
        UserIngestionService.RecordExtractionFacts(job, Result(null));

        Assert.Equal(42, job.UserBook.PageCount);
        Assert.Equal("Pdf", job.SourceFormat);
    }

    [Fact]
    public void PDF2_NeedsPageCount_OnlyPdfWithoutCount()
    {
        var needs = PdfPageCountBackfill.NeedsPageCount.Compile();
        UserBook Book(BookFormat format, int? pages) => new()
        {
            Title = "t",
            Slug = "t",
            Language = "en",
            PageCount = pages,
            BookFiles = [new UserBookFile { StoragePath = "p", Format = format, OriginalFileName = "f", Sha256 = "s" }],
        };

        Assert.True(needs(Book(BookFormat.Pdf, null)));
        Assert.False(needs(Book(BookFormat.Pdf, 12)));
        Assert.False(needs(Book(BookFormat.Epub, null)));
    }

    [Fact]
    public async Task PDF2_BackfillRunAsync_OneBookFails_OthersStillWritten()
    {
        var (ok1, boom, unreadable, ok2) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var written = new Dictionary<Guid, int>();

        var (updated, failed) = await PdfPageCountBackfill.RunAsync(
            [(ok1, "a"), (boom, "b"), (unreadable, "c"), (ok2, "d")],
            path => path switch { "b" => throw new IOException("disk"), "c" => null, _ => 7 },
            (id, pages) => { written[id] = pages; return Task.CompletedTask; },
            _ => { });

        Assert.Equal((2, 2), (updated, failed));
        Assert.Equal(new Dictionary<Guid, int> { [ok1] = 7, [ok2] = 7 }, written);
    }
}
