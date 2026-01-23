using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;

namespace TextStack.Extraction.Tests;

public class Fb2ExtractorTests
{
    private const string MinimalFb2 = """
        <?xml version="1.0" encoding="utf-8"?>
        <FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
          <description>
            <title-info>
              <author><first-name>John</first-name><last-name>Doe</last-name></author>
              <book-title>Test Book</book-title>
              <lang>en</lang>
            </title-info>
          </description>
          <body>
            <section>
              <title><p>Chapter One</p></title>
              <p>This is the first paragraph.</p>
            </section>
          </body>
        </FictionBook>
        """;

    [Fact]
    public async Task ExtractAsync_ValidFb2_ReturnsUnitsWithMetadata()
    {
        var extractor = new Fb2TextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(MinimalFb2));
        var request = new ExtractionRequest { Content = stream, FileName = "test.fb2" };

        var result = await extractor.ExtractAsync(request);

        Assert.Single(result.Units);
        Assert.Equal("Test Book", result.Metadata.Title);
        Assert.Equal("John Doe", result.Metadata.Authors);
        Assert.Equal(SourceFormat.Fb2, result.SourceFormat);
        Assert.Equal(TextSource.NativeText, result.Diagnostics.TextSource);
    }

    [Fact]
    public async Task ExtractAsync_InvalidXml_NeverThrows()
    {
        var extractor = new Fb2TextExtractor();
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes("not valid xml"));
        var request = new ExtractionRequest { Content = stream, FileName = "invalid.fb2" };

        var exception = await Record.ExceptionAsync(() => extractor.ExtractAsync(request));

        Assert.Null(exception);
    }
}
