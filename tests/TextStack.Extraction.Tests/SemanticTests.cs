using TextStack.Extraction.Typography;

namespace TextStack.Extraction.Tests;

public class SemanticTests
{
    [Theory]
    [InlineData("Mr. Smith", "<abbr epub:type=\"z3998:name-title\">Mr.</abbr>")]
    [InlineData("Mrs. Jones", "<abbr epub:type=\"z3998:name-title\">Mrs.</abbr>")]
    [InlineData("Dr. Brown", "<abbr epub:type=\"z3998:name-title\">Dr.</abbr>")]
    [InlineData("Prof. Wilson", "<abbr epub:type=\"z3998:name-title\">Prof.</abbr>")]
    public void Semanticate_NameTitles(string input, string expectedContains)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expectedContains, result);
    }

    [Theory]
    [InlineData("etc.", "<abbr>etc.</abbr>")]
    [InlineData("viz.", "<abbr>viz.</abbr>")]
    [InlineData("cf.", "<abbr>cf.</abbr>")]
    [InlineData("ed.", "<abbr>ed.</abbr>")]
    [InlineData("vs.", "<abbr>vs.</abbr>")]
    public void Semanticate_CommonAbbreviations(string input, string expected)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("i.e.", "<abbr epub:type=\"z3998:initialism\">i.e.</abbr>")]
    [InlineData("e.g.", "<abbr epub:type=\"z3998:initialism\">e.g.</abbr>")]
    public void Semanticate_LatinAbbreviations(string input, string expected)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("AD", "<abbr epub:type=\"se:era\">AD</abbr>")]
    [InlineData("BC", "<abbr epub:type=\"se:era\">BC</abbr>")]
    public void Semanticate_EraDates(string input, string expected)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expected, result);
    }

    [Theory]
    [InlineData("Chapter IV", "z3998:roman")]
    [InlineData("Volume XII", "z3998:roman")]
    [InlineData("Part III", "z3998:roman")]
    public void Semanticate_RomanNumerals(string input, string expectedType)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expectedType, result);
    }

    [Theory]
    [InlineData("10 cm", "<abbr>cm</abbr>")]
    [InlineData("5 kg", "<abbr>kg</abbr>")]
    [InlineData("100 ml", "<abbr>ml</abbr>")]
    public void Semanticate_SiMeasurements(string input, string expectedContains)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expectedContains, result);
    }

    [Theory]
    [InlineData("Jan.", "<abbr>Jan.</abbr>")]
    [InlineData("Feb.", "<abbr>Feb.</abbr>")]
    [InlineData("Dec.", "<abbr>Dec.</abbr>")]
    public void Semanticate_MonthAbbreviations(string input, string expected)
    {
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains(expected, result);
    }

    [Fact]
    public void Semanticate_Null_ReturnsNull()
    {
        var result = SemanticProcessor.Semanticate(null!);
        Assert.Null(result);
    }

    [Fact]
    public void Semanticate_Empty_ReturnsEmpty()
    {
        var result = SemanticProcessor.Semanticate("");
        Assert.Equal("", result);
    }

    [Fact]
    public void Semanticate_PreservesHtmlStructure()
    {
        var input = "<p>Mr. Smith went to Dr. Brown.</p>";
        var result = SemanticProcessor.Semanticate(input);
        Assert.Contains("<p>", result);
        Assert.Contains("</p>", result);
    }

    [Fact]
    public void Semanticate_DoesNotDoubleWrap()
    {
        // Already wrapped abbreviation should not be wrapped again
        var input = "<abbr>Mr.</abbr> Smith";
        var result = SemanticProcessor.Semanticate(input);
        // Should not have nested abbr tags
        Assert.DoesNotContain("<abbr><abbr>", result);
    }
}
