using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Configuration;

namespace TextStack.Extraction.Tests;

public class SemanticTests
{
    private readonly SemanticProcessor _processor = new();
    private readonly ProcessingContext _context = new("en", new TextProcessingOptions());

    [Theory]
    [InlineData("Mr. Smith", "<abbr epub:type=\"z3998:name-title\">Mr.</abbr>")]
    [InlineData("Mrs. Jones", "<abbr epub:type=\"z3998:name-title\">Mrs.</abbr>")]
    [InlineData("Dr. Brown", "<abbr epub:type=\"z3998:name-title\">Dr.</abbr>")]
    [InlineData("Prof. Wilson", "<abbr epub:type=\"z3998:name-title\">Prof.</abbr>")]
    public void Process_NameTitles(string input, string expectedContains)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expectedContains, result);
    }

    [Theory]
    [InlineData("etc.", "<abbr>etc.</abbr>")]
    [InlineData("viz.", "<abbr>viz.</abbr>")]
    [InlineData("cf.", "<abbr>cf.</abbr>")]
    [InlineData("ed.", "<abbr>ed.</abbr>")]
    [InlineData("vs.", "<abbr>vs.</abbr>")]
    public void Process_CommonAbbreviations(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("i.e.", "<abbr epub:type=\"z3998:initialism\">i.e.</abbr>")]
    [InlineData("e.g.", "<abbr epub:type=\"z3998:initialism\">e.g.</abbr>")]
    public void Process_LatinAbbreviations(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("AD", "<abbr epub:type=\"se:era\">AD</abbr>")]
    [InlineData("BC", "<abbr epub:type=\"se:era\">BC</abbr>")]
    public void Process_EraDates(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("Chapter IV", "z3998:roman")]
    [InlineData("Volume XII", "z3998:roman")]
    [InlineData("Part III", "z3998:roman")]
    public void Process_RomanNumerals(string input, string expectedType)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expectedType, result);
    }

    [Theory]
    [InlineData("10 cm", "<abbr>cm</abbr>")]
    [InlineData("5 kg", "<abbr>kg</abbr>")]
    [InlineData("100 ml", "<abbr>ml</abbr>")]
    public void Process_SiMeasurements(string input, string expectedContains)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expectedContains, result);
    }

    [Theory]
    [InlineData("Jan.", "<abbr>Jan.</abbr>")]
    [InlineData("Feb.", "<abbr>Feb.</abbr>")]
    [InlineData("Dec.", "<abbr>Dec.</abbr>")]
    public void Process_MonthAbbreviations(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expected, result);
    }

    [Fact]
    public void Process_Null_ReturnsNull()
    {
        var result = _processor.Process(null!, _context);
        Assert.Null(result);
    }

    [Fact]
    public void Process_Empty_ReturnsEmpty()
    {
        var result = _processor.Process("", _context);
        Assert.Equal("", result);
    }

    [Fact]
    public void Process_PreservesHtmlStructure()
    {
        var input = "<p>Mr. Smith went to Dr. Brown.</p>";
        var result = _processor.Process(input, _context);
        Assert.Contains("<p>", result);
        Assert.Contains("</p>", result);
    }

    [Fact]
    public void Process_DoesNotDoubleWrap()
    {
        // Already wrapped abbreviation should not be wrapped again
        var input = "<abbr>Mr.</abbr> Smith";
        var result = _processor.Process(input, _context);
        // Should not have nested abbr tags
        Assert.DoesNotContain("<abbr><abbr>", result);
    }
}
