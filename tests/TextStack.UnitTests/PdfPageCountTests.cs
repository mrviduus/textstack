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
    [Trait("Rule", "PDF-2")]
    public void RecordExtractionFacts_StoresCountOnlyWhenKnown()
    {
        var job = new UserIngestionJob { UserBook = new UserBook { Title = "t", Slug = "t", Language = "en" } };

        UserIngestionService.RecordExtractionFacts(job, Result(42));
        UserIngestionService.RecordExtractionFacts(job, Result(null));

        Assert.Equal(42, job.UserBook.PageCount);
        Assert.Equal("Pdf", job.SourceFormat);
    }

}
