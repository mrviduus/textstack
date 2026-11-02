using Domain.Enums;

namespace Application.AdminAuth;

/// <summary>
/// The admin panel's sign-in, as <c>AdminAuthEndpoints</c> and <c>AdminAuthMiddleware</c> use it: legacy
/// <see cref="AdminAuthService"/> (table <c>admin_users</c>) and <see cref="Identity.V2AdminAuthService"/>
/// (an account with <c>role = 'admin'</c>) behind one contract, picked at M5.1. Admin and reader tokens
/// are not interchangeable: an admin access token is never a reader's, and refresh and logout here
/// accept only refresh tokens this service issued, which the reader service refuses.
/// </summary>
public interface IAdminAuthService
{
    /// <summary>Null for an unknown email, the wrong password, or an account that is not an (active) admin.</summary>
    Task<AdminAuthResult?> LoginAsync(string email, string password, CancellationToken ct);

    /// <summary>Rotates the admin's refresh token; null when it is unknown or expired, or the admin no longer is one.</summary>
    Task<AdminAuthResult?> RefreshTokenAsync(string refreshToken, CancellationToken ct);

    Task<bool> LogoutAsync(string refreshToken, CancellationToken ct);

    Task<AdminUserDto?> GetAdminByIdAsync(Guid adminId, CancellationToken ct);

    (Guid? adminId, AdminRole? role) ValidateAccessToken(string accessToken);

    Task<int> GetAccessTokenExpiryMinutesAsync(CancellationToken ct = default);

    Task<int> GetRefreshTokenExpiryDaysAsync(CancellationToken ct = default);
}

/// <summary>A signed-in admin and its token pair.</summary>
public sealed record AdminAuthResult(AdminUserDto Admin, string AccessToken, string RefreshToken);
