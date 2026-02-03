using System.Text;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.Lint;

namespace TextStack.Extraction.Tests;

/// <summary>
/// Tests for "The Secret History" by Donna Tartt to debug processing issues.
/// </summary>
public class SecretHistoryTests
{
    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "secret_history.epub");

    [Fact]
    public async Task ExtractAsync_SecretHistory_ExtractsSuccessfully()
    {
        // Skip if file doesn't exist
        if (!File.Exists(FixturePath))
        {
            return;
        }

        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "secret_history.epub" };

        var result = await extractor.ExtractAsync(request);

        // Basic assertions
        Assert.NotNull(result);
        Assert.NotEmpty(result.Units);

        // Log metadata
        Console.WriteLine($"Title: {result.Metadata.Title}");
        Console.WriteLine($"Authors: {result.Metadata.Authors}");
        Console.WriteLine($"Language: {result.Metadata.Language}");
        Console.WriteLine($"Units count: {result.Units.Count}");
        Console.WriteLine($"Source format: {result.SourceFormat}");
        Console.WriteLine($"Text source: {result.Diagnostics.TextSource}");

        // Check for warnings
        if (result.Diagnostics.Warnings.Any())
        {
            Console.WriteLine("\nWarnings:");
            foreach (var warning in result.Diagnostics.Warnings)
            {
                Console.WriteLine($"  - [{warning.Code}] {warning.Message}");
            }
        }
    }

    [Fact]
    public async Task ExtractAsync_SecretHistory_CheckChapterContent()
    {
        if (!File.Exists(FixturePath))
        {
            return;
        }

        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "secret_history.epub" };

        var result = await extractor.ExtractAsync(request);

        Console.WriteLine($"\n=== Chapter Analysis ===\n");

        var chapterNum = 0;
        foreach (var unit in result.Units.Take(10)) // First 10 chapters
        {
            chapterNum++;
            Console.WriteLine($"\n--- Chapter {chapterNum}: {unit.Title ?? "(no title)"} ---");
            Console.WriteLine($"Type: {unit.Type}");
            Console.WriteLine($"HTML length: {unit.Html?.Length ?? 0}");
            Console.WriteLine($"PlainText length: {unit.PlainText?.Length ?? 0}");

            // Check for Russian characters (Cyrillic)
            if (unit.Html != null)
            {
                var cyrillicCount = unit.Html.Count(c => c >= '\u0400' && c <= '\u04FF');
                if (cyrillicCount > 0)
                {
                    Console.WriteLine($"⚠️ CYRILLIC CHARS FOUND: {cyrillicCount}");

                    // Find and show cyrillic snippets
                    var cyrillicMatches = System.Text.RegularExpressions.Regex.Matches(
                        unit.Html, @"[\u0400-\u04FF]+");
                    foreach (System.Text.RegularExpressions.Match match in cyrillicMatches.Take(5))
                    {
                        var start = Math.Max(0, match.Index - 20);
                        var len = Math.Min(60, unit.Html.Length - start);
                        var context = unit.Html.Substring(start, len);
                        Console.WriteLine($"  Context: ...{context}...");
                    }
                }
            }

            // Show first 200 chars of content
            if (unit.PlainText?.Length > 0)
            {
                var preview = unit.PlainText.Substring(0, Math.Min(200, unit.PlainText.Length));
                Console.WriteLine($"Preview: {preview}...");
            }
        }
    }

    [Fact]
    public async Task ExtractAsync_SecretHistory_DetectEncodingIssues()
    {
        if (!File.Exists(FixturePath))
        {
            return;
        }

        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "secret_history.epub" };

        var result = await extractor.ExtractAsync(request);

        Console.WriteLine("\n=== Encoding Analysis ===\n");

        foreach (var unit in result.Units)
        {
            if (unit.Html == null) continue;

            // Check for mojibake patterns
            var mojibakePatterns = new[]
            {
                "Ã", "â€", "Ð", "Ñ", "ï»¿", // Common mojibake
                "Â", "Ã©", "Ã¨", "Ã ", // UTF-8 as Latin-1
            };

            foreach (var pattern in mojibakePatterns)
            {
                if (unit.Html.Contains(pattern))
                {
                    Console.WriteLine($"⚠️ Possible mojibake in '{unit.Title}': found '{pattern}'");

                    var idx = unit.Html.IndexOf(pattern);
                    var start = Math.Max(0, idx - 10);
                    var len = Math.Min(40, unit.Html.Length - start);
                    Console.WriteLine($"  Context: {unit.Html.Substring(start, len)}");
                }
            }

            // Check for replacement character
            if (unit.Html.Contains('\uFFFD'))
            {
                var count = unit.Html.Count(c => c == '\uFFFD');
                Console.WriteLine($"⚠️ Replacement chars (�) in '{unit.Title}': {count}");
            }
        }
    }

    [Fact]
    public async Task ExtractAsync_SecretHistory_RunLinter()
    {
        if (!File.Exists(FixturePath))
        {
            return;
        }

        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "secret_history.epub" };

        var result = await extractor.ExtractAsync(request);

        var linter = new Linter();
        var allIssues = new List<LintIssue>();

        var chapterNum = 0;
        foreach (var unit in result.Units)
        {
            chapterNum++;
            if (unit.Html != null)
            {
                var issues = linter.LintChapter(unit.Html, chapterNum).ToList();
                allIssues.AddRange(issues);
            }
        }

        Console.WriteLine($"\n=== Lint Results ===\n");
        Console.WriteLine($"Total issues: {allIssues.Count}");

        // Group by code
        var grouped = allIssues.GroupBy(i => i.Code).OrderByDescending(g => g.Count());
        foreach (var group in grouped.Take(10))
        {
            Console.WriteLine($"  {group.Key}: {group.Count()} occurrences");
            // Show first example
            var first = group.First();
            Console.WriteLine($"    Example: {first.Message}");
            if (first.Context != null)
            {
                Console.WriteLine($"    Context: {first.Context}");
            }
        }
    }

    [Fact]
    public async Task ExtractAsync_SecretHistory_TestTextProcessing()
    {
        if (!File.Exists(FixturePath))
        {
            return;
        }

        var extractor = new EpubTextExtractor();
        await using var stream = File.OpenRead(FixturePath);
        var request = new ExtractionRequest { Content = stream, FileName = "secret_history.epub" };

        var result = await extractor.ExtractAsync(request);

        // Get first non-empty chapter
        var chapter = result.Units.FirstOrDefault(u => u.Html?.Length > 100);
        if (chapter?.Html == null)
        {
            Console.WriteLine("No suitable chapter found");
            return;
        }

        Console.WriteLine($"\n=== Text Processing Test ===\n");
        Console.WriteLine($"Chapter: {chapter.Title}");
        Console.WriteLine($"Original length: {chapter.Html.Length}");

        // Test each processor individually
        var context = new ProcessingContext(result.Metadata.Language ?? "en", new TextProcessingOptions());

        var processors = new ITextProcessor[]
        {
            new SpellingProcessor(),
            new TypographyProcessor(),
            new SemanticProcessor(),
        };

        var html = chapter.Html;
        foreach (var processor in processors)
        {
            try
            {
                var before = html.Length;
                html = processor.Process(html, context);
                var after = html.Length;
                Console.WriteLine($"  {processor.Name}: {before} -> {after} ({after - before:+#;-#;0})");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  ❌ {processor.Name} FAILED: {ex.Message}");
                Console.WriteLine($"     {ex.StackTrace?.Split('\n').FirstOrDefault()}");
            }
        }
    }
}
