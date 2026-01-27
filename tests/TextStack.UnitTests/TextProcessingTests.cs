using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.Typography;
using TextStack.Extraction.Utilities;

namespace TextStack.UnitTests;

public class TextProcessingTests
{
    private static readonly IProcessingContext DefaultContext = new ProcessingContext("en");

    [Fact]
    public void SpellingProcessor_ModernizesToday()
    {
        var processor = new SpellingProcessor();
        var input = "We shall meet to-day and to-morrow.";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("today", result);
        Assert.Contains("tomorrow", result);
        Assert.DoesNotContain("to-day", result);
        Assert.DoesNotContain("to-morrow", result);
    }

    [Fact]
    public void SpellingProcessor_ModernizesConnexion()
    {
        var processor = new SpellingProcessor();
        var input = "The connexion was clear.";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("connection", result);
        Assert.DoesNotContain("connexion", result);
    }

    [Fact]
    public void SpellingProcessor_ModernizesShew()
    {
        var processor = new SpellingProcessor();
        var input = "He shewed great courage and shewn his strength.";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("showed", result);
        Assert.Contains("shown", result);
    }

    [Fact]
    public void Contractions_FixesTwas()
    {
        var input = " twas a dark night. 'Tis true!";
        var result = Contractions.FixArchaicContractions(input);

        Assert.Contains("\u2019twas", result);
        Assert.Contains("\u2019Tis", result);
    }

    [Fact]
    public void Currency_NormalizesLToPound()
    {
        var input = "The price was L50 for the goods.";
        var result = Currency.NormalizeCurrency(input);

        Assert.Contains("£50", result);
        Assert.DoesNotContain("L50", result);
    }

    [Fact]
    public void Fractions_ConvertsToUnicode()
    {
        var input = "He ate 1/2 of the pie and 3/4 of the cake.";
        var result = Fractions.ConvertFractions(input);

        Assert.Contains("½", result);
        Assert.Contains("¾", result);
    }

    [Fact]
    public void TypographyProcessor_SmartQuotes()
    {
        var processor = new TypographyProcessor();
        var input = "\"Hello,\" he said. \"How are you?\"";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("\u201C", result);
        Assert.Contains("\u201D", result);
        Assert.DoesNotContain("\"", result);
    }

    [Fact]
    public void TypographyProcessor_EmDash()
    {
        var processor = new TypographyProcessor();
        var input = "word--word and word---word";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("\u2014", result);
        Assert.Contains("\u2E3B", result);
    }

    [Fact]
    public void SemanticProcessor_MarksAbbreviations()
    {
        var processor = new SemanticProcessor();
        var input = "Mr. Smith met Dr. Jones.";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("<abbr", result);
        Assert.Contains("epub:type=\"z3998:name-title\"", result);
    }

    [Fact]
    public void SemanticProcessor_MarksRomanNumerals()
    {
        var processor = new SemanticProcessor();
        var input = "Chapter III and Volume IV";
        var result = processor.Process(input, DefaultContext);

        Assert.Contains("<span epub:type=\"z3998:roman\">III</span>", result);
        Assert.Contains("<span epub:type=\"z3998:roman\">IV</span>", result);
    }

    [Fact]
    public void HtmlCleaner_FullPipeline()
    {
        var input = @"
            <p>""To-day we meet,"" said Mr. Smith.</p>
            <p>'Twas the connexion that mattered.</p>
            <p>The price: L50 for 1/2.</p>
        ";

        var (html, _) = HtmlCleaner.Clean(input);

        // Spelling modernization
        Assert.Contains("today", html.ToLower());
        Assert.Contains("connection", html.ToLower());

        // Smart quotes
        Assert.Contains("\u201C", html);

        // Contractions
        Assert.Contains("\u2019", html);

        // Currency
        Assert.Contains("£50", html);

        // Fractions
        Assert.Contains("½", html);

        // Abbreviations
        Assert.Contains("<abbr", html);
    }

    [Fact]
    public void PipelineBuilder_CreatesDefaultPipeline()
    {
        var pipeline = PipelineBuilder.CreateDefault().Build();
        var context = new ProcessingContext("en");

        var (html, plainText) = pipeline.Process("<p>To-day</p>", context);

        Assert.Contains("today", html.ToLower());
        Assert.NotEmpty(plainText);
    }

    [Fact]
    public void PipelineBuilder_RespectsOptions()
    {
        var options = new TextProcessingOptions { EnableSpelling = false };
        var pipeline = PipelineBuilder.CreateDefault(options).Build();
        var context = new ProcessingContext("en", options);

        var (html, _) = pipeline.Process("<p>to-day</p>", context);

        // Spelling should NOT be modernized
        Assert.Contains("to-day", html);
    }
}
