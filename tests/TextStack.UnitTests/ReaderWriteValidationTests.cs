using Api.Endpoints;
using Api.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

namespace TextStack.UnitTests;

/// <summary>
/// Reader audit L4 / web L5: writes Postgres or the JSON binder refused answered 500 — a vocabulary
/// sentence over its column, a non-GUID chapter id on a bookmark. They are the caller's mistake: 400.
/// </summary>
public class ReaderWriteValidationTests
{
    [Fact]
    public void TooLong_SentenceOver1000_Rejected()
    {
        Assert.Equal("Sentence too long (max 1000 chars)",
            VocabularyEndpoints.TooLong("t", "d", new string('s', 1001), "b"));
    }

    [Fact]
    public void TooLong_AtLimitsAndPaddedByWhitespace_Accepted()
    {
        Assert.Null(VocabularyEndpoints.TooLong(
            new string('t', 500), new string('d', 2000), "  " + new string('s', 1000) + "  ", new string('b', 500)));
        Assert.Null(VocabularyEndpoints.TooLong(null, null));
    }

    [Theory]
    [InlineData(501, 0, "Translation too long (max 500 chars)")]
    [InlineData(0, 2001, "Definition too long (max 2000 chars)")]
    public void TooLong_TranslationOrDefinitionOver_Rejected(int translation, int definition, string expected)
    {
        Assert.Equal(expected, VocabularyEndpoints.TooLong(new string('t', translation), new string('d', definition)));
    }

    [Fact]
    public async Task InvokeAsync_BodyDoesNotBind_Returns400()
    {
        var middleware = new ExceptionMiddleware(
            _ => throw new BadHttpRequestException("Failed to read parameter \"CreateBookmarkRequest request\""),
            NullLogger<ExceptionMiddleware>.Instance);
        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };

        await middleware.InvokeAsync(ctx);

        Assert.Equal(StatusCodes.Status400BadRequest, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_UnexpectedException_Still500()
    {
        var middleware = new ExceptionMiddleware(
            _ => throw new InvalidOperationException("boom"), NullLogger<ExceptionMiddleware>.Instance);
        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };

        await middleware.InvokeAsync(ctx);

        Assert.Equal(StatusCodes.Status500InternalServerError, ctx.Response.StatusCode);
    }
}
