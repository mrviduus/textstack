using System.Text.Json;
using Api.Mapping;
using Application.AdminAuth;
using Application.Auth;
using Domain.Entities;
using Domain.Enums;

namespace TextStack.UnitTests;

/// <summary>R4 mapping-layer guard: a fixture entity serialises to the exact expected JSON.</summary>
public class MappingTests
{
    private static readonly Guid G1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTimeOffset T1 = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);

    private static string Json<T>(T value) => JsonSerializer.Serialize(value);

    // ---- Fixtures -------------------------------------------------------------

    private static User NewUser() => new()
    {
        Id = G1,
        Email = "u@example.com",
        Name = "Jane",
        Picture = "pic.png",
        IsGuest = false,
        CreatedAt = T1,
        NativeLanguage = "uk",
    };

    private static AdminUser NewAdmin() => new()
    {
        Id = G1,
        Email = "admin@example.com",
        PasswordHash = "hash",
        Role = AdminRole.Editor,
        CreatedAt = T1,
    };

    // ---- JSON snapshots -------------------------------------------------------

    [Fact]
    public void UserToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Email\":\"u@example.com\",\"Name\":\"Jane\",\"Picture\":\"pic.png\"," +
            "\"IsGuest\":false,\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"," +
            "\"NativeLanguage\":\"uk\"}";
        Assert.Equal(expected, Json(NewUser().ToDto()));
    }

    [Fact]
    public void AdminUserToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Email\":\"admin@example.com\",\"Role\":1," +
            "\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"}";
        Assert.Equal(expected, Json(NewAdmin().ToDto()));
    }
}
