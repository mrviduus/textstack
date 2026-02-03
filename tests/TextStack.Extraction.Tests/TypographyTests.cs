using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Configuration;

namespace TextStack.Extraction.Tests;

public class TypographyTests
{
    private readonly TypographyProcessor _processor = new();
    private readonly ProcessingContext _context = new("en", new TextProcessingOptions());

    [Theory]
    [InlineData("\"Hello\"", "\u201CHello\u201D")]  // Smart double quotes
    [InlineData("'Hello'", "\u2018Hello\u2019")]    // Smart single quotes
    [InlineData("it's", "it\u2019s")]               // Apostrophe in contraction
    [InlineData("don't", "don\u2019t")]             // Apostrophe in don't
    public void Process_SmartQuotes(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("...", "\u2026")]                                // Ellipsis
    [InlineData(". . .", "\u2026")]                              // Spaced dots to ellipsis
    public void Process_Ellipsis(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("1/4", "\u00BC")]    // Quarter
    [InlineData("1/2", "\u00BD")]    // Half
    [InlineData("3/4", "\u00BE")]    // Three quarters
    [InlineData("1/3", "\u2153")]    // Third
    [InlineData("2/3", "\u2154")]    // Two thirds
    public void Process_Fractions(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("Mr. Smith", "Mr.\u00a0Smith")]      // Nbsp after Mr.
    [InlineData("Mrs. Jones", "Mrs.\u00a0Jones")]    // Nbsp after Mrs.
    [InlineData("Dr. Brown", "Dr.\u00a0Brown")]      // Nbsp after Dr.
    public void Process_TitleAbbreviations(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("i. e.", "i.e.")]    // No space in i.e.
    [InlineData("e. g.", "e.g.")]    // No space in e.g.
    public void Process_LatinAbbreviations(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Process_NumberRanges()
    {
        var result = _processor.Process("10-20", _context);
        Assert.Contains("\u2013", result);  // Contains en dash
    }

    [Theory]
    [InlineData("c/o", "\u2105")]    // Care of symbol
    [InlineData("C/O", "\u2105")]    // Care of (uppercase)
    public void Process_CareOf(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("O.K.", "OK")]    // O.K. to OK
    public void Process_OK(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
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
    public void Process_PreservesHtmlTags()
    {
        var input = "<p>Hello \"world\"</p>";
        var result = _processor.Process(input, _context);
        Assert.Contains("<p>", result);
        Assert.Contains("</p>", result);
        Assert.Contains("\u201C", result);  // Left quote
        Assert.Contains("\u201D", result);  // Right quote
    }

    [Theory]
    [InlineData("M'Gregor", "McGregor")]         // Scottish name
    [InlineData("M'Donald", "McDonald")]         // Scottish name
    [InlineData("O'Brien", "O\u2019Brien")]      // Irish name with proper apostrophe
    public void Process_ScottishIrishNames(string input, string expected)
    {
        var result = _processor.Process(input, _context);
        Assert.Equal(expected, result);
    }
}
