using System.Text.Json;
using Domain.Exceptions;
using TextStack.Ai.Core;

namespace Api.Middleware;

public class ExceptionMiddleware(RequestDelegate next, ILogger<ExceptionMiddleware> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (Exception ex)
        {
            await HandleExceptionAsync(context, ex);
        }
    }

    private async Task HandleExceptionAsync(HttpContext context, Exception exception)
    {
        var (statusCode, response) = exception switch
        {
            NotFoundException ex => (StatusCodes.Status404NotFound,
                new ErrorResponse(ex.Code, ex.Message)),

            ConflictException ex => (StatusCodes.Status409Conflict,
                new ErrorResponse(ex.Code, ex.Message)),

            ValidationException ex => (StatusCodes.Status400BadRequest,
                new ValidationErrorResponse(ex.Code, ex.Message, ex.Errors)),

            DomainException ex => (StatusCodes.Status400BadRequest,
                new ErrorResponse(ex.Code, ex.Message)),

            // A body that does not bind (e.g. a non-GUID chapterId). The framework throws this to us
            // instead of answering it, so without this arm every malformed request was a 500.
            BadHttpRequestException ex => (ex.StatusCode,
                new ErrorResponse("BAD_REQUEST", ex.Message)),

            // Per-feature daily budget hit in hard-stop mode (Phase 12 RLOps slice 4).
            BudgetExceededException ex => (StatusCodes.Status429TooManyRequests,
                new ErrorResponse("BUDGET_EXCEEDED", ex.Message)),

            _ => HandleUnexpectedException(exception)
        };

        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(JsonSerializer.Serialize(response, JsonOptions));
    }

    private (int, ErrorResponse) HandleUnexpectedException(Exception ex)
    {
        logger.LogError(ex, "Unhandled exception");
        return (StatusCodes.Status500InternalServerError,
            new ErrorResponse("INTERNAL_ERROR", "An unexpected error occurred"));
    }

    private record ErrorResponse(string Code, string Message);
    private record ValidationErrorResponse(string Code, string Message, IDictionary<string, string[]> Errors)
        : ErrorResponse(Code, Message);
}

public static class ExceptionMiddlewareExtensions
{
    public static IApplicationBuilder UseExceptionMiddleware(this IApplicationBuilder app)
        => app.UseMiddleware<ExceptionMiddleware>();
}
