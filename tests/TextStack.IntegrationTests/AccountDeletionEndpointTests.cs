using System.Net;

namespace TextStack.IntegrationTests;

/// <summary>
/// GDPR / Google-Play hard-delete contract for <c>DELETE /me/account</c>: anonymous is refused. The
/// delete itself (rows, files, tokens) is covered on V2 by Persistence.Tests
/// (<c>V2AuthServiceTests.DeleteAccountAsync_*</c>, <c>NativeIdentityApiTests</c>) and here by
/// <c>GuestSessionEndpointTests.DeleteAccount_GuestToken_RowGone</c>.
/// </summary>
public class AccountDeletionEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public AccountDeletionEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task DeleteAccount_WithoutAuth_Returns401()
    {
        var req = _fixture.CreateRequest(HttpMethod.Delete, "/me/account");
        var resp = await _fixture.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
