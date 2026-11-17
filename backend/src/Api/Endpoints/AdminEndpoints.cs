using Application.Admin;
using Contracts.Admin;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class AdminEndpoints
{
    private static IResult ToResult((bool Success, string? Error) r)
        => r.Success ? Results.Ok() : Results.BadRequest(new { error = r.Error });

    public static void MapAdminEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin").WithTags("Admin");

        // User uploads
        group.MapGet("/user-uploads", GetUserUploads)
            .WithName("GetUserUploads");

        group.MapGet("/user-uploads/stats", GetUserUploadStats)
            .WithName("GetUserUploadStats");

        group.MapDelete("/user-uploads/{id:guid}", DeleteUserUpload)
            .WithName("DeleteUserUpload");

        group.MapPost("/user-uploads/{id:guid}/takedown", TakedownUserUpload)
            .WithName("TakedownUserUpload")
            .WithDescription("Soft-delete a user upload (DMCA / admin takedown). Hides from user, keeps record for audit.");
    }

    // User upload endpoints

    private static async Task<IResult> GetUserUploads(
        AdminService adminService,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        [FromQuery] string? userType,
        [FromQuery] string? search,
        CancellationToken ct)
    {
        UserBookStatus? statusEnum = null;
        if (!string.IsNullOrEmpty(status) && Enum.TryParse<UserBookStatus>(status, true, out var parsed))
            statusEnum = parsed;

        var query = new UserUploadsQuery(offset ?? 0, limit ?? 20, statusEnum, userType, search);
        var result = await adminService.GetUserUploadsAsync(query, ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> GetUserUploadStats(
        AdminService adminService,
        CancellationToken ct)
    {
        var stats = await adminService.GetUserUploadStatsAsync(ct);
        return Results.Ok(stats);
    }

    private static async Task<IResult> DeleteUserUpload(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.DeleteUserUploadAsync(id, ct));

    private static async Task<IResult> TakedownUserUpload(
        Guid id,
        [FromBody] TakedownUserBookRequest request,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.TakedownUserUploadAsync(id, request.Reason, ct));
}
