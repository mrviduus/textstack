using TextStack.Extraction.Typography;

namespace TextStack.Extraction.Tests;

public class TypographyTests
{
    [Theory]
    [InlineData("\"Hello\"", "\u201CHello\u201D")]  // Smart double quotes
    [InlineData("'Hello'", "\u2018Hello\u2019")]    // Smart single quotes
    [InlineData("it's", "it\u2019s")]               // Apostrophe in contraction
    [InlineData("don't", "don\u2019t")]             // Apostrophe in don't
    public void Typogrify_SmartQuotes(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("...", "\u2026")]                                // Ellipsis
    [InlineData(". . .", "\u2026")]                              // Spaced dots to ellipsis
    public void Typogrify_Ellipsis(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("1/4", "\u00BC")]    // Quarter
    [InlineData("1/2", "\u00BD")]    // Half
    [InlineData("3/4", "\u00BE")]    // Three quarters
    [InlineData("1/3", "\u2153")]    // Third
    [InlineData("2/3", "\u2154")]    // Two thirds
    public void Typogrify_Fractions(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("Mr. Smith", "Mr.\u00a0Smith")]      // Nbsp after Mr.
    [InlineData("Mrs. Jones", "Mrs.\u00a0Jones")]    // Nbsp after Mrs.
    [InlineData("Dr. Brown", "Dr.\u00a0Brown")]      // Nbsp after Dr.
    public void Typogrify_TitleAbbreviations(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("i. e.", "i.e.")]    // No space in i.e.
    [InlineData("e. g.", "e.g.")]    // No space in e.g.
    public void Typogrify_LatinAbbreviations(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Typogrify_NumberRanges()
    {
        var result = TypographyProcessor.Typogrify("10-20");
        Assert.Contains("\u2013", result);  // Contains en dash
    }

    [Theory]
    [InlineData("c/o", "\u2105")]    // Care of symbol
    [InlineData("C/O", "\u2105")]    // Care of (uppercase)
    public void Typogrify_CareOf(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("O.K.", "OK")]    // O.K. to OK
    public void Typogrify_OK(string input, string expected)
    {
        var result = TypographyProcessor.Typogrify(input);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void Typogrify_Null_ReturnsNull()
    {
        var result = TypographyProcessor.Typogrify(null!);
        Assert.Null(result);
    }

    [Fact]
    public void Typogrify_Empty_ReturnsEmpty()
    {
        var result = TypographyProcessor.Typogrify("");
        Assert.Equal("", result);
    }

    [Fact]
    public void Typogrify_PreservesHtmlTags()
    {
        var input = "<p>Hello \"world\"</p>";
        var result = TypographyProcessor.Typogrify(input);
        Assert.Contains("<p>", result);
        Assert.Contains("</p>", result);
        Assert.Contains("\u201C", result);  // Left quote
        Assert.Contains("\u201D", result);  // Right quote
    }
}
