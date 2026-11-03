using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary><c>PUT /me/profile</c> on <c>IUserRepository</c> (#1100): what a partial update leaves alone.</summary>
public class ProfileEndpointTests(LiveApiFixture fixture) : IClassFixture<LiveApiFixture>
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task UpdateProfile_NameOnly_KeepsTheNativeLanguage()
    {
        var jwt = await SignUpAsync();
        Assert.SkipWhen(jwt is null, "registration unavailable");
        Assert.Equal(HttpStatusCode.OK, (await PutAsync(jwt!, new { name = "Ann", nativeLanguage = "uk" })).StatusCode);

        var renamed = await PutAsync(jwt!, new { name = "Ann B" });

        var user = (await renamed.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("user");
        Assert.Equal(("Ann B", "uk"), (user.GetProperty("name").GetString(), user.GetProperty("nativeLanguage").GetString()));
    }

    private async Task<HttpResponseMessage> PutAsync(string bearer, object body)
    {
        var req = fixture.CreateRequest(HttpMethod.Put, "/me/profile");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearer}");
        req.Content = JsonContent.Create(body);
        return await fixture.Client.SendAsync(req, Ct);
    }

    private async Task<string?> SignUpAsync()
    {
        var req = fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        req.Headers.Add("X-Client", "mobile");
        req.Content = JsonContent.Create(new { email = $"profile-{Guid.NewGuid():N}@textstack.test", password = "correct-horse-battery", name = "Profile Probe" });
        var resp = await fixture.Client.SendAsync(req, Ct);
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");
        if (IntegrationSkip.Unavailable(resp) || !resp.IsSuccessStatusCode) return null;
        return (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("accessToken").GetString();
    }
}
