using Domain.Enums;

namespace Application.AdminAuth;

public record AdminLoginRequest(string Email, string Password);

public record AdminAuthResponse(AdminUserDto User);

public record AdminUserDto(Guid Id, string Email, AdminRole Role, DateTimeOffset CreatedAt);
