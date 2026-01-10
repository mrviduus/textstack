namespace Application.Auth;

public record GoogleLoginRequest(string IdToken);

public record AuthResponse(UserDto User);

public record UserDto(Guid Id, string Email, string? Name, string? Picture, DateTimeOffset CreatedAt);
