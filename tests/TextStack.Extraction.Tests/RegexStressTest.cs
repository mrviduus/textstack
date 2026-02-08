using System.Diagnostics;
using System.Text;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Processors;
using Xunit;

namespace TextStack.Extraction.Tests;

public class RegexStressTest
{
    [Fact]
    public void SemanticProcessor_LargeHtmlWithoutAbbrTags_CompletesWithinTimeout()
    {
        // Generate HTML that could cause backtracking issues with old lookbehind patterns
        var sb = new StringBuilder();
        sb.Append("<p>");
        for (int i = 0; i < 5000; i++)
        {
            sb.Append("This is Dr. Smith talking about USA and UK. ");
            sb.Append("<span class=\"test\">More content with < and > symbols.</span> ");
        }
        sb.Append("</p>");

        var hugeHtml = sb.ToString();
        var context = new ProcessingContext("en");
        var processor = new SemanticProcessor();

        var sw = Stopwatch.StartNew();
        var result = processor.Process(hugeHtml, context);
        sw.Stop();

        // Should complete in reasonable time (under 30 seconds)
        Assert.True(sw.ElapsedMilliseconds < 30000, $"Took {sw.ElapsedMilliseconds}ms");
        Assert.NotEmpty(result);
    }

    [Fact]
    public void TypographyProcessor_LargeHtml_CompletesWithinTimeout()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < 5000; i++)
        {
            sb.Append("<p>\"Hello,\" he said. 'Test' -- more text... 1-2 ranges.</p>");
        }

        var hugeHtml = sb.ToString();
        var context = new ProcessingContext("en");
        var processor = new TypographyProcessor();

        var sw = Stopwatch.StartNew();
        var result = processor.Process(hugeHtml, context);
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds < 30000, $"Took {sw.ElapsedMilliseconds}ms");
        Assert.NotEmpty(result);
    }

    [Fact]
    public void Pipeline_LargeHtml_CompletesWithoutCrash()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < 2000; i++)
        {
            sb.Append("<p>Dr. Smith from USA said \"Hello\" on Jan. 1st, AD 2024. Temp: 20km/h.</p>");
        }

        var hugeHtml = sb.ToString();
        var context = new ProcessingContext("en");
        var pipeline = PipelineBuilder.CreateDefault().Build();

        var sw = Stopwatch.StartNew();
        var (html, plain) = pipeline.Process(hugeHtml, context);
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds < 60000, $"Took {sw.ElapsedMilliseconds}ms");
        Assert.NotEmpty(html);
        Assert.NotEmpty(plain);
    }
}
