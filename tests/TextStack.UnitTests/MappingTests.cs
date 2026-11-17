using System.Text.Json;
using Api.Mapping;
using Domain.Identity;

namespace TextStack.UnitTests;

/// <summary>Mapping-layer guard: a fixture account serialises to the exact expected JSON.</summary>
public class MappingTests
{
    [Fact]
    public void UserToDto_Fixture_MatchesSnapshot()
    {
        var user = new UserAccount
        {
            Id = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Email = "u@example.com",
            Name = "Jane",
            Picture = "pic.png",
            IsGuest = false,
            CreatedAt = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero),
            NativeLanguage = "uk",
        };
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Email\":\"u@example.com\",\"Name\":\"Jane\",\"Picture\":\"pic.png\"," +
            "\"IsGuest\":false,\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"," +
            "\"NativeLanguage\":\"uk\"}";
        Assert.Equal(expected, JsonSerializer.Serialize(user.ToDto()));
    }
}
