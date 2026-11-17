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
