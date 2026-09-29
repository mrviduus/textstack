using Api.Extensions;
using Api.Mapping;
using Application.Auth;
using Application.Common.Interfaces;
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
        AuthService authService,
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
        AuthService authService,
        IAppDbContext db,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        user.Name = request.Name?.Trim();

        // NativeLanguage: treat omitted (null) as "don't change"; empty string as "clear".
        // Only persist the value when the request includes a non-null field — otherwise
        // a simple name update would silently wipe the user's language preference.
        if (request.NativeLanguage != null)
        {
            var trimmed = request.NativeLanguage.Trim();
            if (trimmed.Length == 0)
            {
                user.NativeLanguage = null;
            }
            else if (NativeLanguageShape.IsMatch(trimmed))
            {
                user.NativeLanguage = trimmed;
            }
            else
            {
                return Results.BadRequest(new { error = "Invalid native language code" });
            }
        }

        await db.SaveChangesAsync(ct);

        return Results.Ok(new AuthResponse(user.ToDto()));
    }

    private static async Task<IResult> UploadAvatar(
        IFormFile file,
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        IImageOptimizer imageOptimizer,
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

        // Delete old avatar if it's a local file (not external URL like Google)
        if (!string.IsNullOrEmpty(user.Picture) && !user.Picture.StartsWith("http"))
        {
            await storage.DeleteFileAsync(user.Picture, ct);
        }

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var mimeType = file.ContentType ?? "image/jpeg";
        var optimized = await imageOptimizer.OptimizeAsync(ms.ToArray(), mimeType, ct: ct);

        using var optimizedStream = new MemoryStream(optimized.Data);
        var fileName = $"avatar{optimized.Extension}";
        var relativePath = await storage.SaveFileAsync(userId.Value, fileName, optimizedStream, ct);

        user.Picture = relativePath;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new AuthResponse(user.ToDto()));
    }

    private static async Task<IResult> DeleteAvatar(
        AuthService authService,
        IAppDbContext db,
        IFileStorageService storage,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var user = await authService.GetUserByIdAsync(userId.Value, ct);
        if (user == null) return Results.Unauthorized();

        if (!string.IsNullOrEmpty(user.Picture) && !user.Picture.StartsWith("http"))
        {
            await storage.DeleteFileAsync(user.Picture, ct);
        }

        user.Picture = null;
        await db.SaveChangesAsync(ct);

        return Results.Ok();
    }
}

public record UpdateProfileRequest(string? Name, string? NativeLanguage = null);
