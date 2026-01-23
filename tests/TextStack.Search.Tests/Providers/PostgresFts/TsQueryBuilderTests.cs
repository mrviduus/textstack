using TextStack.Search.Enums;
using TextStack.Search.Providers.PostgresFts;

namespace TextStack.Search.Tests.Providers.PostgresFts;

public class TsQueryBuilderTests
{
    private readonly TsQueryBuilder _builder = new();

    #region BuildQuery Tests

    [Fact]
    public void BuildQuery_SingleWord_ReturnsSingleToken()
    {
        var result = _builder.BuildQuery("hello", SearchLanguage.En);

        Assert.Equal("hello:*", result);
    }

    [Fact]
    public void BuildQuery_MultipleWords_JoinsWithAnd()
    {
        var result = _builder.BuildQuery("hello world", SearchLanguage.En);

        Assert.Equal("hello:* & world:*", result);
    }

    [Fact]
    public void BuildQuery_ExtraSpaces_NormalizesWhitespace()
    {
        var result = _builder.BuildQuery("  hello    world  ", SearchLanguage.En);

        Assert.Equal("hello:* & world:*", result);
    }

    [Fact]
    public void BuildQuery_UpperCase_ConvertsToLower()
    {
        var result = _builder.BuildQuery("HELLO World", SearchLanguage.En);

        Assert.Equal("hello:* & world:*", result);
    }

    [Fact]
    public void BuildQuery_EmptyString_ReturnsEmpty()
    {
        var result = _builder.BuildQuery("", SearchLanguage.En);

        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void BuildQuery_WhitespaceOnly_ReturnsEmpty()
    {
        var result = _builder.BuildQuery("   ", SearchLanguage.En);

        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void BuildQuery_Null_ReturnsEmpty()
    {
        var result = _builder.BuildQuery(null!, SearchLanguage.En);

        Assert.Equal(string.Empty, result);
    }

    [Theory]
    [InlineData("hello&world", "helloworld:*")]
    [InlineData("test|query", "testquery:*")]
    [InlineData("search!term", "searchterm:*")]
    [InlineData("(grouped)", "grouped:*")]
    [InlineData("prefix:*", "prefix:*")]
    [InlineData("test<>value", "testvalue:*")]
    public void BuildQuery_SpecialCharacters_AreRemoved(string input, string expected)
    {
        var result = _builder.BuildQuery(input, SearchLanguage.En);

        Assert.Equal(expected, result);
    }

    [Fact]
    public void BuildQuery_MixedSpecialCharsAndSpaces_HandlesCorrectly()
    {
        var result = _builder.BuildQuery("hello & world | test", SearchLanguage.En);

        Assert.Equal("hello:* & world:* & test:*", result);
    }

    #endregion

    #region BuildPrefixQuery Tests

    [Fact]
    public void BuildPrefixQuery_SingleWord_AddsPrefixOperator()
    {
        var result = _builder.BuildPrefixQuery("hel");

        Assert.Equal("hel:*", result);
    }

    [Fact]
    public void BuildPrefixQuery_MultipleWords_OnlyLastGetsPrefixOperator()
    {
        var result = _builder.BuildPrefixQuery("hello wor");

        Assert.Equal("hello & wor:*", result);
    }

    [Fact]
    public void BuildPrefixQuery_EmptyString_ReturnsEmpty()
    {
        var result = _builder.BuildPrefixQuery("");

        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void BuildPrefixQuery_SpecialChars_AreRemoved()
    {
        var result = _builder.BuildPrefixQuery("test:");

        Assert.Equal("test:*", result);
    }

    #endregion

    #region GetLanguageConfig Tests

    [Theory]
    [InlineData(SearchLanguage.En, "english")]
    [InlineData(SearchLanguage.Uk, "simple")]
    [InlineData(SearchLanguage.Auto, "simple")]
    public void GetLanguageConfig_ReturnsCorrectConfig(SearchLanguage language, string expected)
    {
        var result = _builder.GetLanguageConfig(language);

        Assert.Equal(expected, result);
    }

    #endregion
}
