using Api.Extensions;
using Api.Mapping;
using Application.Identity;
using Application.Common.Interfaces;
using Domain.Identity;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class ProfileEndpoints
{
    private static readonly string[] AllowedPhotoExtensions = [".jpg", ".jpeg", ".png"];
    private const long MaxPhotoSize = 2 * 1024 * 1024; // 2MB

    // BCP-47 shape: 2–3 letter base code, optional region suffix (e.g. "en", "pt-BR").
    // Stored as-is; language-list validation is a client concern — we only guard against
    // unbounded / malformed payload (XSS / DB bloat).
    private static readonly System.Text.RegularExpressions.Regex NativeLanguageShape =
        new("^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public static void MapProfileEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/profile").WithTags("Profile").RejectOAuthTokens();

        group.MapGet("/", GetProfile).WithName("GetProfile");
        group.MapPut("/", UpdateProfile).WithName("UpdateProfile");
        group.MapPost("/avatar", UploadAvatar).WithName("UploadAvatar").DisableAntiforgery();
        group.MapDelete("/avatar", DeleteAvatar).WithName("DeleteAvatar");
    }

    // Returns the current user (incl. NativeLanguage) so clients can refresh a
    // stale cached user object — mobile uses this on launch to pick up a native
    // language the user set on another device.
    private static async Task<IResult> GetProfile(
        IAuthService authService,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        return Results.Ok(new AuthResponse(user.ToDto()));
    }

    private static async Task<IResult> UpdateProfile(
        [FromBody] UpdateProfileRequest request,
        IAuthService authService,
        IUserRepository users,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        // NativeLanguage: treat omitted (null) as "don't change"; empty string as "clear".
        // Only change the value when the request includes a non-null field — otherwise
        // a simple name update would silently wipe the user's language preference.
        var nativeLanguage = user.NativeLanguage;
        if (request.NativeLanguage != null)
        {
            var trimmed = request.NativeLanguage.Trim();
            if (trimmed.Length == 0)
            {
                nativeLanguage = null;
            }
            else if (NativeLanguageShape.IsMatch(trimmed))
            {
                nativeLanguage = trimmed;
            }
            else
            {
                return Results.BadRequest(new { error = "Invalid native language code" });
            }
        }

        // An omitted name (null) keeps the current one, as NativeLanguage does.
        var name = request.Name is null ? user.Name : request.Name.Trim();
        var updated = await users.UpdateNameAndLanguageAsync(userId.Value, name, nativeLanguage, ct);
        return updated == null ? Results.Unauthorized() : Results.Ok(new AuthResponse(updated.ToDto()));
    }

    internal static async Task<IResult> UploadAvatar(
        IFormFile file,
        IAuthService authService,
        IUserRepository users,
        IFileStorageService storage,
        IImageOptimizer imageOptimizer,
        ILogger<IFileStorageService> logger,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        if (file.Length == 0)
            return Results.BadRequest(new { error = "File is empty" });

        if (file.Length > MaxPhotoSize)
            return Results.BadRequest(new { error = "File too large. Max 2MB allowed" });

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!AllowedPhotoExtensions.Contains(ext))
            return Results.BadRequest(new { error = "Invalid file type. Only JPG and PNG allowed" });

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var mimeType = file.ContentType ?? "image/jpeg";
        var optimized = await imageOptimizer.OptimizeAsync(ms.ToArray(), mimeType, ct: ct);

        // New file, then the row, then the old file: a failure at any step leaves the account
        // pointing at a photo that exists. A fresh name never overwrites the photo in use.
        using var optimizedStream = new MemoryStream(optimized.Data);
        var fileName = $"avatar-{Guid.NewGuid():N}{optimized.Extension}";
        var relativePath = await storage.SaveFileAsync(userId.Value, fileName, optimizedStream, ct);

        var oldPicture = user.Picture;
        UserAccount? updated;
        try { updated = await users.SetPictureAsync(userId.Value, relativePath, ct); }
        catch { await TryDeleteAsync(storage, relativePath, logger); throw; }
        if (updated == null)
        {
            await TryDeleteAsync(storage, relativePath, logger);
            return Results.Unauthorized();
        }

        // The new photo is in use already; a leftover old file is only wasted bytes.
        if (UserAccount.IsStoredPicture(oldPicture) && oldPicture != relativePath)
            await TryDeleteAsync(storage, oldPicture!, logger);
        return Results.Ok(new AuthResponse(updated.ToDto()));
    }

    // Best-effort: a file left behind is logged, never a failed request.
    private static async Task TryDeleteAsync(IFileStorageService storage, string path, ILogger logger)
    {
        try { await storage.DeleteFileAsync(path, CancellationToken.None); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Could not delete avatar file {Path}; it is left as an orphan", path);
        }
    }

    private static async Task<IResult> DeleteAvatar(
        IAuthService authService,
        IUserRepository users,
        IFileStorageService storage,
        ILogger<IFileStorageService> logger,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        // The row first: a failed file delete leaves an orphan file, never a broken avatar.
        var oldPicture = user.Picture;
        await users.SetPictureAsync(userId.Value, null, ct);
        if (UserAccount.IsStoredPicture(oldPicture))
            await TryDeleteAsync(storage, oldPicture!, logger);
        return Results.Ok();
    }
}

public record UpdateProfileRequest(string? Name, string? NativeLanguage = null);
