using System.Text.RegularExpressions;
using Application.Ai;
using Domain.LLM;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// Prompts name the reader's language ("Ukrainian"), never its code ("uk"): small local models
/// answer in English when handed a code. Plus the two parser guards for what those models send back.
/// </summary>
public class LlmLanguageNameTests
{
    [Theory]
    [InlineData("uk", "Ukrainian")]
    [InlineData("ru", "Russian")]
    [InlineData("en", "English")]
    [InlineData("pt-BR", "Portuguese (Brazil)")]
    [InlineData("pt-br", "Portuguese (Brazil)")]
    [InlineData("zh-TW", "Chinese (Traditional)")]
    [InlineData("zh", "Chinese")]
    [InlineData("en-US", "English")]
    [InlineData(" UK ", "Ukrainian")]
    public void ToEnglishName_KnownCode_ReturnsEnglishName(string code, string expected) =>
        Assert.Equal(expected, LanguageNames.ToEnglishName(code));

    [Theory]
    [InlineData("xx", "xx")]
    [InlineData("xx-YY", "xx-YY")]
    [InlineData("Ukrainian", "Ukrainian")]
    [InlineData("", "")]
    public void ToEnglishName_UnknownCode_PassesThrough(string code, string expected) =>
        Assert.Equal(expected, LanguageNames.ToEnglishName(code));

    [Fact]
    public void ToEnglishName_EveryCodeInSharedCatalogue_MapsToItsEnglishName()
    {
        var ts = File.ReadAllText(FindRepoFile("packages/shared/src/languages.ts"));
        var entries = Regex.Matches(ts, @"code: '([^']+)', englishName: '([^']+)'");

        Assert.True(entries.Count > 80, $"parsed only {entries.Count} entries from languages.ts");
        foreach (Match m in entries)
            Assert.Equal(m.Groups[2].Value, LanguageNames.ToEnglishName(m.Groups[1].Value));
    }

    [Fact]
    public void ExplainPromptBuildSystemPrompt_LanguageCode_RespondsInLanguageName() =>
        Assert.Contains("Respond in Ukrainian.", ExplainPrompt.BuildSystemPrompt(null, "uk"));

    [Fact]
    public void TranslatePromptBuildSystemPrompt_LanguageCodes_UsesLanguageNames() =>
        Assert.Contains("Translate from English to Russian.", TranslatePrompt.BuildSystemPrompt("en", "ru", null, null));

    [Theory]
    [InlineData("<think>let me see\n[1]</think>\nHINT: x", "HINT: x")]
    [InlineData("</think>\n\nHINT: x", "HINT: x")]
    [InlineData("  <think></think>HINT: x", "HINT: x")]
    [InlineData("HINT: x", "HINT: x")]
    [InlineData("HINT: </think> stays", "HINT: </think> stays")]
    [InlineData("<think>never closed", "<think>never closed")]
    public void StripThinking_LeadingThinkBlock_IsRemoved(string raw, string expected) =>
        Assert.Equal(expected, OllamaLlmClient.StripThinking(raw));

    private static string FindRepoFile(string relative)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var path = Path.Combine(dir.FullName, relative);
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException($"{relative} not found above {AppContext.BaseDirectory}");
    }
}
