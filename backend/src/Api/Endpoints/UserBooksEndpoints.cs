using Application.Auth;
using Application.Common.Interfaces;
using Application.UserBooks;
using Contracts.UserBooks;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class UserBooksEndpoints
{
    public static void MapUserBooksEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/books").WithTags("User Books");

        group.MapPost("/upload", UploadBook)
            .WithName("UploadUserBook")
            .DisableAntiforgery();

        group.MapGet("", GetBooks).WithName("GetUserBooks");
        group.MapGet("/quota", GetStorageQuota).WithName("GetStorageQuota");
        group.MapGet("/{id:guid}", GetBook).WithName("GetUserBook");
        group.MapGet("/{id:guid}/chapters/{chapterNumber:int}", GetChapter).WithName("GetUserBookChapter");
        group.MapGet("/{id:guid}/assets/{assetId:guid}", GetAsset).WithName("GetUserBookAsset");
        group.MapPost("/{id:guid}/retry", RetryBook).WithName("RetryUserBook");
        group.MapPost("/{id:guid}/cancel", CancelBook).WithName("CancelUserBook");
        group.MapDelete("/{id:guid}", DeleteBook).WithName("DeleteUserBook");
    }

    private static Guid? GetUserId(HttpContext httpContext, AuthService authService)
    {
        var accessToken = httpContext.Request.Cookies["access_token"];
        if (string.IsNullOrEmpty(accessToken)) return null;
        return authService.ValidateAccessToken(accessToken);
    }

    private static async Task<IResult> UploadBook(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        [FromForm] IFormFile file,
        [FromForm] string? title,
        [FromForm] string? language,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        if (file == null || file.Length == 0)
            return Results.BadRequest("No file provided");

        await using var stream = file.OpenReadStream();
        var (response, error) = await userBookService.UploadAsync(
            userId.Value, stream, file.FileName, title, language, ct);

        if (error is not null)
            return Results.BadRequest(new { error });

        return Results.Ok(response);
    }

    private static async Task<IResult> GetBooks(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var books = await userBookService.GetBooksAsync(userId.Value, ct);
        return Results.Ok(books);
    }

    private static async Task<IResult> GetStorageQuota(
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var quota = await userBookService.GetStorageQuotaAsync(userId.Value, ct);
        return Results.Ok(quota);
    }

    private static async Task<IResult> GetBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var book = await userBookService.GetBookAsync(userId.Value, id, ct);
        if (book is null) return Results.NotFound();

        return Results.Ok(book);
    }

    private static async Task<IResult> GetChapter(
        Guid id,
        int chapterNumber,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var chapter = await userBookService.GetChapterAsync(userId.Value, id, chapterNumber, ct);
        if (chapter is null) return Results.NotFound();

        return Results.Ok(chapter);
    }

    private static async Task<IResult> GetAsset(
        Guid id,
        Guid assetId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        // Build expected path pattern
        var userIdStr = userId.Value.ToString();
        var pathPattern = $"users/{userIdStr[..2]}/{userIdStr}/books/{id}/assets/{assetId}";

        // Find file with any extension
        var basePath = storage.GetFullPath($"users/{userIdStr[..2]}/{userIdStr}/books/{id}/assets");
        if (!Directory.Exists(basePath))
            return Results.NotFound();

        var files = Directory.GetFiles(basePath, $"{assetId}.*");
        if (files.Length == 0)
            return Results.NotFound();

        var filePath = files[0];
        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        var contentType = ext switch
        {
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            _ => "image/jpeg"
        };

        var stream = await storage.GetFileAsync(
            filePath.Replace(storage.GetFullPath(""), "").TrimStart(Path.DirectorySeparatorChar), ct);

        if (stream is null)
            return Results.NotFound();

        return Results.File(stream, contentType);
    }

    private static async Task<IResult> RetryBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.RetryAsync(userId.Value, id, ct);
        if (!success)
            return Results.BadRequest(new { error });

        return Results.Ok(new { status = "Processing" });
    }

    private static async Task<IResult> CancelBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.CancelAsync(userId.Value, id, ct);
        if (!success)
            return Results.BadRequest(new { error });

        return Results.Ok(new { status = "Cancelled" });
    }

    private static async Task<IResult> DeleteBook(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        UserBookService userBookService,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var (success, error) = await userBookService.DeleteAsync(userId.Value, id, ct);
        if (!success)
            return Results.NotFound(new { error });

        return Results.NoContent();
    }
}
