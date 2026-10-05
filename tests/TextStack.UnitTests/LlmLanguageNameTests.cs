using System.Text.RegularExpressions;
using Application.Ai;
using Domain.Utilities;
using TextStack.Ai.Llm;
using TextStack.Vocabulary;
using Worker.Services;

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
    public void DistractorPromptBuild_LanguageCodes_NamesBothLanguages()
    {
        var (_, user) = DistractorPrompt.Build("вода", "uk", null, "Він випив воду.", "ru");

        Assert.Contains("Language: Ukrainian", user);
        Assert.Contains("Write 2-3 sentences in Russian explaining", user);
        Assert.DoesNotContain("in ru ", user);
    }

    [Fact]
    public void DistractorPromptBuild_Always_HasNoExampleWordsToCopy()
    {
        var (_, user) = DistractorPrompt.Build("latency", "en", null, null, "uk");

        Assert.Contains("SINGLE WORD ONLY", user);
        Assert.DoesNotContain("linearizability", user);
        Assert.DoesNotContain("sharding", user);
    }

    [Fact]
    public void ExplainPromptBuildSystemPrompt_LanguageCode_RespondsInLanguageName() =>
        Assert.Contains("Respond in Ukrainian.", ExplainPrompt.BuildSystemPrompt(null, "uk"));

    [Fact]
    public void TranslatePromptBuildSystemPrompt_LanguageCodes_UsesLanguageNames() =>
        Assert.Contains("Translate from English to Russian.", TranslatePrompt.BuildSystemPrompt("en", "ru", null, null));

    [Theory]
    [InlineData("[\"a\",\"b\"]\n[\"a\",\"b\"]")]                    // array repeated
    [InlineData("Tags: [\"a\", \"b\"]. Hope that helps [1].")]      // trailing bracket in prose
    [InlineData("```json\n[\"a\",\"b\"]\n```\n[\"c\"]")]
    public void ParseAndValidate_MoreThanOneArray_TakesFirst(string raw) =>
        Assert.Equal(["a", "b"], TagSuggestionGenerator.ParseAndValidate(raw));

    [Fact]
    public void ParseAndValidate_BracketsAndEscapedQuotesInStrings_AreNotStructure() =>
        // Normalize then drops the punctuation: "a]b" → "ab", "c\"d" → "cd".
        Assert.Equal(["ab", "cd"], TagSuggestionGenerator.ParseAndValidate("[\"a]b\", \"c\\\"d\"] [\"x\"]"));

    [Theory]
    [InlineData("[\"a\", \"b\"")]
    [InlineData("no array here")]
    public void ParseAndValidate_NoCompleteArray_ReturnsEmpty(string raw) =>
        Assert.Empty(TagSuggestionGenerator.ParseAndValidate(raw));

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
