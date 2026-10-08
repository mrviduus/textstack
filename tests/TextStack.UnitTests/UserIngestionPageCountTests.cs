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

    // Review r7 of #780: a retry whose extraction learnt nothing keeps the stored count.
    [Fact]
    public void RecordExtractionFacts_NoPageCount_StoredCountKept()
    {
        var job = Job();
        job.UserBook.PageCount = 42;

        UserIngestionService.RecordExtractionFacts(job, Result(TextSource.None, null));

        Assert.Equal(42, job.UserBook.PageCount);
    }
}
