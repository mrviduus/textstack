using Api.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using NSubstitute;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// #1520: /explain streamed its answer, then threw. The handler tried to set a 500 on a response
/// already sent, threw again, and Sentry saw only that second error. The real one must be logged.
/// </summary>
public class ExceptionMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_ThrowsAfterResponseStarted_LogsOriginalAndAborts()
    {
        var logger = new CapturingLogger<ExceptionMiddleware>();
        var boom = new InvalidOperationException("stream broke mid-answer");
        var middleware = new ExceptionMiddleware(_ => throw boom, logger);
        // Like Kestrel: once headers are sent, setting the status throws.
        var response = Substitute.For<IHttpResponseFeature>();
        response.HasStarted.Returns(true);
        response.When(r => r.StatusCode = Arg.Any<int>()).Do(_ =>
            throw new InvalidOperationException("StatusCode cannot be set because the response has already started."));
        var lifetime = Substitute.For<IHttpRequestLifetimeFeature>();
        var ctx = new DefaultHttpContext();
        ctx.Features.Set(response);
        ctx.Features.Set(lifetime);

        await middleware.InvokeAsync(ctx);

        Assert.Same(boom, Assert.Single(logger.Errors).Exception);
        lifetime.Received(1).Abort();
    }

    [Fact]
    public async Task InvokeAsync_ClientLeftMidStream_AbortsWithoutAnErrorLogged()
    {
        // A reader closing the explanation is not a server error: no Sentry noise.
        var logger = new CapturingLogger<ExceptionMiddleware>();
        var middleware = new ExceptionMiddleware(_ => throw new OperationCanceledException(), logger);
        var response = Substitute.For<IHttpResponseFeature>();
        response.HasStarted.Returns(true);
        var lifetime = Substitute.For<IHttpRequestLifetimeFeature>();
        lifetime.RequestAborted.Returns(new CancellationToken(canceled: true));
        var ctx = new DefaultHttpContext();
        ctx.Features.Set(response);
        ctx.Features.Set(lifetime);

        await middleware.InvokeAsync(ctx);

        Assert.Empty(logger.Errors);
        lifetime.Received(1).Abort();
    }
}
