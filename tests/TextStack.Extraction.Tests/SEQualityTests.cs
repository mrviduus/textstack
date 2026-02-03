using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.Lint;
using TextStack.Extraction.Lint.Rules;
using TextStack.Extraction.Typography;
using TextStack.Extraction.Semantic;

namespace TextStack.Extraction.Tests;

/// <summary>
/// Tests for Standard Ebooks quality integration features.
/// </summary>
public class SEQualityTests
{
    private readonly ProcessingContext _context = new("en", new TextProcessingOptions());

    #region Phase 1: Typography Enhancements

    [Theory]
    [InlineData("M'Gregor", "McGregor")]
    [InlineData("M'Donald", "McDonald")]
    [InlineData("M'Pherson", "McPherson")]
    public void Names_ScottishMcNames(string input, string expected)
    {
        var result = Names.NormalizeNames(input);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("O'Brien", "O\u2019Brien")]
    [InlineData("O'Connor", "O\u2019Connor")]
    public void Names_IrishONames(string input, string expected)
    {
        var result = Names.NormalizeNames(input);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Phase 2: Spelling

    [Theory]
    [InlineData("colour", "color")]
    [InlineData("Colour", "Color")]
    [InlineData("colours", "colors")]
    [InlineData("favour", "favor")]
    [InlineData("honour", "honor")]
    [InlineData("behaviour", "behavior")]
    public void Spelling_BritishToAmerican(string input, string expected)
    {
        var processor = new SpellingProcessor();
        var result = processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("connexion", "connection")]
    [InlineData("to-day", "today")]
    [InlineData("to-morrow", "tomorrow")]
    [InlineData("to-night", "tonight")]
    [InlineData("shew", "show")]
    [InlineData("shewn", "shown")]
    [InlineData("gaol", "jail")]
    public void Spelling_ArchaicToModern(string input, string expected)
    {
        var processor = new SpellingProcessor();
        var result = processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("centre", "center")]
    [InlineData("theatre", "theater")]
    [InlineData("metre", "meter")]
    [InlineData("fibre", "fiber")]
    public void Spelling_ReToEr(string input, string expected)
    {
        var processor = new SpellingProcessor();
        var result = processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("analyse", "analyze")]
    [InlineData("organise", "organize")]
    [InlineData("realise", "realize")]
    [InlineData("recognise", "recognize")]
    public void Spelling_IseToIze(string input, string expected)
    {
        var processor = new SpellingProcessor();
        var result = processor.Process(input, _context);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Phase 3: Extended Abbreviations

    [Theory]
    [InlineData("Sgt.", "z3998:name-title")]
    [InlineData("Col.", "z3998:name-title")]
    [InlineData("Gen.", "z3998:name-title")]
    [InlineData("Maj.", "z3998:name-title")]
    public void Abbreviations_MilitaryRanks(string input, string expectedType)
    {
        var result = Abbreviations.MarkupExtendedAbbreviations(input);
        Assert.Contains("<abbr", result);
        Assert.Contains(expectedType, result);
    }

    [Theory]
    [InlineData("B.A.", "z3998:initialism")]
    [InlineData("M.A.", "z3998:initialism")]
    [InlineData("Ph.D.", "z3998:initialism")]
    [InlineData("M.D.", "z3998:initialism")]
    public void Abbreviations_AcademicDegrees(string input, string expectedType)
    {
        var result = Abbreviations.MarkupExtendedAbbreviations(input);
        Assert.Contains("<abbr", result);
        Assert.Contains(expectedType, result);
    }

    [Theory]
    [InlineData("Rev.", "z3998:name-title")]
    [InlineData("Rt. Rev.", "z3998:name-title")]
    public void Abbreviations_ReligiousTitles(string input, string expectedType)
    {
        var result = Abbreviations.MarkupExtendedAbbreviations(input);
        Assert.Contains("<abbr", result);
        Assert.Contains(expectedType, result);
    }

    #endregion

    #region Phase 4: Currency

    [Theory]
    [InlineData("L50", "\u00A350")]
    [InlineData("L1000", "\u00A31000")]
    public void Currency_LToPound(string input, string expected)
    {
        var result = Currency.NormalizeCurrency(input);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Phase 5: Lint Rules

    [Fact]
    public void Lint_DoubleWord_DetectsRepeatedWords()
    {
        var rule = new DoubleWordRule();
        var issues = rule.Check("the the cat sat on the mat", 1).ToList();
        Assert.Single(issues);
        Assert.Equal("C003", issues[0].Code);
    }

    [Fact]
    public void Lint_DoubleWord_AllowsLegitimateRepeats()
    {
        var rule = new DoubleWordRule();
        var issues = rule.Check("he had had enough", 1).ToList();
        Assert.Empty(issues);
    }

    [Fact]
    public void Lint_EmptyParagraph_DetectsEmptyP()
    {
        var rule = new EmptyParagraphRule();
        var issues = rule.Check("<p></p>", 1).ToList();
        Assert.Single(issues);
        Assert.Equal("H003", issues[0].Code);
    }

    [Fact]
    public void Lint_HeadingHierarchy_DetectsSkippedLevels()
    {
        var rule = new HeadingHierarchyRule();
        var issues = rule.Check("<h1>Title</h1><h3>Section</h3>", 1).ToList();
        Assert.Single(issues);
        Assert.Equal("H002", issues[0].Code);
    }

    [Fact]
    public void Lint_HeadingHierarchy_AllowsProperSequence()
    {
        var rule = new HeadingHierarchyRule();
        var issues = rule.Check("<h1>Title</h1><h2>Chapter</h2><h3>Section</h3>", 1).ToList();
        Assert.Empty(issues);
    }

    [Fact]
    public void Lint_DoubleSpaceAfterPeriod_DetectsTypewriterStyle()
    {
        var rule = new DoubleSpaceAfterPeriodRule();
        var issues = rule.Check("Hello world.  New sentence.", 1).ToList();
        Assert.Single(issues);
        Assert.Equal("T007", issues[0].Code);
    }

    [Fact]
    public void Lint_InconsistentQuotes_DetectsMixedStyles()
    {
        var rule = new InconsistentQuotesRule();
        var html = "\u201CHello\u201D said \"world\"";
        var issues = rule.Check(html, 1).ToList();
        Assert.NotEmpty(issues);
        Assert.Equal("T005", issues[0].Code);
    }

    #endregion

    #region Phase 6: Soft Hyphenation

    [Fact]
    public void SoftHyphen_InsertsHyphensInLongWords()
    {
        var processor = new SoftHyphenProcessor();
        var result = processor.Process("understanding the circumstances", _context);
        Assert.Contains("\u00AD", result);
    }

    [Fact]
    public void SoftHyphen_SkipsShortWords()
    {
        var processor = new SoftHyphenProcessor();
        // Use only short words (< 8 chars) that won't be hyphenated
        var input = "a cat sat on mat";
        var result = processor.Process(input, _context);
        // Verify input/output are identical for short words
        Assert.Equal(input, result);
    }

    [Fact]
    public void SoftHyphen_PreservesHtmlTags()
    {
        var processor = new SoftHyphenProcessor();
        var result = processor.Process("<p>understanding</p>", _context);
        Assert.Contains("<p>", result);
        Assert.Contains("</p>", result);
    }

    #endregion

    #region Linter Integration

    [Fact]
    public void Linter_IncludesAllNewRules()
    {
        var linter = new Linter();

        // Test with content that triggers various rules
        var html = "<p></p><h1>Title</h1><h3>Skip</h3>the the word.  Double space.";
        var issues = linter.LintChapter(html, 1).ToList();

        // Should have issues from multiple rules
        var codes = issues.Select(i => i.Code).Distinct().ToList();

        // Verify at least some of our new rules fired
        Assert.Contains("H002", codes); // HeadingHierarchy
        Assert.Contains("H003", codes); // EmptyParagraph
        Assert.Contains("C003", codes); // DoubleWord
        Assert.Contains("T007", codes); // DoubleSpaceAfterPeriod
    }

    #endregion

    #region Piracy Watermark Filter

    [Theory]
    [InlineData("<p>Спасибо, что скачали книгу в <a href=\"https://royallib.com\">библиотеке</a></p>")]
    [InlineData("<p>Downloaded from flibusta.is - free ebook library</p>")]
    [InlineData("<p>Скачать бесплатно книгу в электронная библиотека coollib.net</p>")]
    public void PiracyWatermark_DetectsPiracySites(string html)
    {
        var result = PiracyWatermarkProcessor.IsPiracyWatermark(html);
        Assert.True(result);
    }

    [Theory]
    [InlineData("<p>The snow in the mountains was melting and Bunny had been dead for several weeks.</p>")]
    [InlineData("<p>Chapter 1: The Beginning</p>")]
    [InlineData("<p>It was a bright cold day in April, and the clocks were striking thirteen.</p>")]
    public void PiracyWatermark_AllowsLegitimateContent(string html)
    {
        var result = PiracyWatermarkProcessor.IsPiracyWatermark(html);
        Assert.False(result);
    }

    [Fact]
    public void PiracyWatermark_FiltersRussianWatermarkWithDomain()
    {
        var html = "<span><p class=\"p\">Спасибо, что скачали книгу в <a href=\"https://royallib.com\">бесплатной электронной библиотеке</a></p></span>";
        var result = PiracyWatermarkProcessor.IsPiracyWatermark(html);
        Assert.True(result);
    }

    #endregion
}
