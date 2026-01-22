namespace Application.Auth;

public class JwtSettings
{
    public const string SectionName = "Jwt";

    public required string SecretKey { get; set; }
    public string Issuer { get; set; } = "textstack.app";
    public int AccessTokenExpiryMinutes { get; set; } = 60;
    public int RefreshTokenExpiryDays { get; set; } = 30;
}
