using Domain.Entities;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using Worker.Services;

namespace TextStack.UnitTests;

// Review of #780: a scanned PDF (no text layer) fails extraction but still opens in the
// Original layout, so its page count is stored before the early failure returns too.
public class UserIngestionPageCountTests
{
    private static ExtractionResult Result(TextSource source, int? pages) => new(
        SourceFormat.Pdf,
        new ExtractionMetadata(null, null, null, null, PageCount: pages),
        [], [],
        new ExtractionDiagnostics(source, null, []));

    private static UserIngestionJob Job() => new()
    {
        Id = Guid.NewGuid(),
        UserBook = new UserBook { Id = Guid.NewGuid(), Title = "t", Slug = "t", Language = "en" },
    };

    [Fact]
    public void RecordExtractionFacts_NoTextLayer_PageCountStored()
    {
        var job = Job();

        UserIngestionService.RecordExtractionFacts(job, Result(TextSource.None, 42));

        Assert.Equal(42, job.UserBook.PageCount);
        Assert.Equal("Pdf", job.SourceFormat);
    }

    [Fact]
    public void RecordExtractionFacts_NoPageCount_Null()
    {
        var job = Job();

        UserIngestionService.RecordExtractionFacts(job, Result(TextSource.NativeText, null));

        Assert.Null(job.UserBook.PageCount);
    }
}
