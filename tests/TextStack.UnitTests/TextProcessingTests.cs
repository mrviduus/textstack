using TextStack.Extraction.Spelling;
using TextStack.Extraction.Typography;
using TextStack.Extraction.Utilities;

namespace TextStack.UnitTests;

public class TextProcessingTests
{
    [Fact]
    public void SpellingProcessor_ModernizesToday()
    {
        var input = "We shall meet to-day and to-morrow.";
        var result = SpellingProcessor.ModernizeSpelling(input);

        Assert.Contains("today", result);
        Assert.Contains("tomorrow", result);
        Assert.DoesNotContain("to-day", result);
        Assert.DoesNotContain("to-morrow", result);
    }

    [Fact]
    public void SpellingProcessor_ModernizesConnexion()
    {
        var input = "The connexion was clear.";
        var result = SpellingProcessor.ModernizeSpelling(input);

        Assert.Contains("connection", result);
        Assert.DoesNotContain("connexion", result);
    }

    [Fact]
    public void SpellingProcessor_ModernizesShew()
    {
        var input = "He shewed great courage and shewn his strength.";
        var result = SpellingProcessor.ModernizeSpelling(input);

        Assert.Contains("showed", result);
        Assert.Contains("shown", result);
    }

    [Fact]
    public void Contractions_FixesTwas()
    {
        var input = " twas a dark night. 'Tis true!";
        var result = Contractions.FixArchaicContractions(input);

        // Should have proper apostrophe (right single quote U+2019)
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
        var result = TextStack.Extraction.Typography.Fractions.ConvertFractions(input);

        Assert.Contains("½", result);  // U+00BD
        Assert.Contains("¾", result);  // U+00BE
    }

    [Fact]
    public void TypographyProcessor_SmartQuotes()
    {
        var input = "\"Hello,\" he said. \"How are you?\"";
        var result = TypographyProcessor.Typogrify(input);

        Assert.Contains("\u201C", result);  // Left double quote
        Assert.Contains("\u201D", result);  // Right double quote
        Assert.DoesNotContain("\"", result);
    }

    [Fact]
    public void TypographyProcessor_EmDash()
    {
        var input = "word--word and word---word";
        var result = TypographyProcessor.Typogrify(input);

        Assert.Contains("\u2014", result);  // Em dash
        Assert.Contains("\u2E3B", result);  // Three-em dash
    }

    [Fact]
    public void SemanticProcessor_MarksAbbreviations()
    {
        var input = "Mr. Smith met Dr. Jones.";
        var result = SemanticProcessor.Semanticate(input);

        Assert.Contains("<abbr", result);
        Assert.Contains("epub:type=\"z3998:name-title\"", result);
    }

    [Fact]
    public void SemanticProcessor_MarksRomanNumerals()
    {
        var input = "Chapter III and Volume IV";
        var result = SemanticProcessor.Semanticate(input);

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

        var (html, _) = HtmlCleaner.CleanHtml(input);

        // Spelling modernization
        Assert.Contains("today", html.ToLower());
        Assert.Contains("connection", html.ToLower());

        // Smart quotes
        Assert.Contains("\u201C", html);  // Left double quote

        // Contractions
        Assert.Contains("\u2019", html);  // Apostrophe

        // Currency
        Assert.Contains("£50", html);

        // Fractions
        Assert.Contains("½", html);

        // Abbreviations
        Assert.Contains("<abbr", html);
    }
}
