using Application.Common.Interfaces;
using Application.UserBooks;
using Domain.Enums;

namespace Application.Admin;

public record UserUploadsQuery(
    int Offset = 0,
    int Limit = 20,
    UserBookStatus? Status = null,
    string? UserType = null,
    string? Search = null);

/// <summary>Admin service: user-upload moderation (AdminService.UserUploads.cs).</summary>
public partial class AdminService(IAppDbContext db, UserBookService userBookService);
