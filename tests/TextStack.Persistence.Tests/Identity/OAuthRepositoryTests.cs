using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Identity;

public class OAuthRepositoryTests(V2PostgresFixture db)
{
    private readonly OAuthRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Resource = "https://textstack.test/mcp";
    private static DateTimeOffset Now => DateTimeOffset.UtcNow;
    private static string NewHash() => V2PostgresFixture.PayloadSha256(Guid.NewGuid().ToString());

    /// <summary>A pending authorization from claude.ai, open for 30 minutes.</summary>
    public static OAuthAuthorization Request() => new()
    {
        Id = Guid.NewGuid(),
        ClientId = "tsc_" + Guid.NewGuid(),
        ClientName = "Claude",
        RedirectUri = "https://claude.ai/api/mcp/auth_callback",
        CodeChallenge = new string('a', 43),
        Resource = Resource,
        Scope = "library",
        ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(30),
    };

    /// <summary>A fresh grant of the app "Claude" redirecting to <paramref name="redirectUri"/>; its access token lives an hour.</summary>
    public static OAuthTokenGrant Grant(string redirectUri = "https://claude.ai/api/mcp/auth_callback") => new()
    {
        Id = Guid.NewGuid(),
        ClientId = "tsc_" + Guid.NewGuid(),
        ClientName = "Claude",
        RedirectUri = redirectUri,
        Resource = Resource,
        Scope = "library",
        AccessTokenHash = NewHash(),
        AccessTokenExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        RefreshTokenHash = NewHash(),
        RefreshTokenExpiresAt = DateTimeOffset.UtcNow.AddDays(90),
    };

    private async Task<OAuthAuthorization> CreatedRequestAsync()
    {
        var request = Request();
        await _repo.CreateRequestAsync(request, Ct);
        return request;
    }

    private async Task<(Guid User, OAuthTokenGrant Grant)> ConnectedAsync()
    {
        var user = await db.NewReaderAsync();
        var grant = Grant();
        await _repo.ConnectAsync(user, grant, Ct);
        return (user, grant);
    }

    [Fact]
    public async Task SaveClientAsync_SameClientIdAgain_RefreshesTheRegistration()
    {
        var url = $"https://client.test/{Guid.NewGuid()}.json";
        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "Old", RedirectUris = ["https://a.test/cb"], IsMetadataDocument = true }, Ct);

        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "New", RedirectUris = ["https://b.test/cb"], IsMetadataDocument = true, FetchedAt = Now }, Ct);

        var client = (await _repo.GetClientAsync(url, Ct))!;
        Assert.Equal(("New", "https://b.test/cb"), (client.ClientName, Assert.Single(client.RedirectUris)));
        Assert.NotNull(client.FetchedAt);
    }

    [Fact]
    public async Task ApproveRequestAsync_Pending_BindsItToTheUserWithTheCode()
    {
        var user = await db.NewReaderAsync();
        var request = await CreatedRequestAsync();
        var code = NewHash();

        var approved = (await _repo.ApproveRequestAsync(request.Id, user, code, Now.AddMinutes(5), Now, Ct))!;

        Assert.Equal((user, code), (approved.UserId!.Value, approved.CodeHash));
        Assert.Equal(request.Id, (await _repo.GetRequestByCodeAsync(code, Ct))?.Id);
    }

    [Fact]
    public async Task ApproveRequestAsync_AlreadyApproved_ReturnsNullAndKeepsTheFirstUser()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, alice, NewHash(), Now.AddMinutes(5), Now, Ct);

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, bob, NewHash(), Now.AddMinutes(5), Now, Ct));
        Assert.Equal(alice, (await _repo.GetRequestAsync(request.Id, Ct))!.UserId);
    }

    [Fact]
    public async Task ApproveRequestAsync_Denied_ReturnsNull()
    {
        var request = await CreatedRequestAsync();
        await _repo.DenyRequestAsync(request.Id, Now, Ct);

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), Now.AddMinutes(5), Now, Ct));
    }

    [Fact]
    public async Task ApproveRequestAsync_PastTheConsentDeadline_ReturnsNull()
    {
        var request = await CreatedRequestAsync();

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), Now.AddHours(2), Now.AddHours(1), Ct));
    }

    [Fact]
    public async Task DenyRequestAsync_Pending_DeniesItOnce()
    {
        var request = await CreatedRequestAsync();

        Assert.True(await _repo.DenyRequestAsync(request.Id, Now, Ct));

        Assert.NotNull((await _repo.GetRequestAsync(request.Id, Ct))!.DeniedAt);
        Assert.False(await _repo.DenyRequestAsync(request.Id, Now, Ct));
    }

    [Fact]
    public async Task DenyRequestAsync_Approved_ReturnsFalseAndKeepsTheApproval()
    {
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), Now.AddMinutes(5), Now, Ct);

        Assert.False(await _repo.DenyRequestAsync(request.Id, Now, Ct));
        Assert.Null((await _repo.GetRequestAsync(request.Id, Ct))!.DeniedAt);
    }

    [Fact]
    public async Task DenyRequestAsync_PastTheConsentDeadline_ReturnsFalse()
    {
        var request = await CreatedRequestAsync();

        Assert.False(await _repo.DenyRequestAsync(request.Id, Now.AddHours(1), Ct));
    }

    [Fact]
    public async Task BurnCodeAsync_SecondRedemption_ReturnsFalse()
    {
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), Now.AddMinutes(5), Now, Ct);

        Assert.True(await _repo.BurnCodeAsync(request.Id, Now, Ct));

        Assert.False(await _repo.BurnCodeAsync(request.Id, Now, Ct));
        Assert.NotNull((await _repo.GetRequestAsync(request.Id, Ct))!.ConsumedAt);
    }

    [Fact]
    public async Task DeleteRequestsCreatedBeforeAsync_Cutoff_DeletesOnlyOlderRequests()
    {
        var (old, atCutoff) = (await CreatedRequestAsync(), await CreatedRequestAsync());
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition("""
                UPDATE oauth_authorization_requests SET created_at = '2003-01-01Z' WHERE id = @old;
                UPDATE oauth_authorization_requests SET created_at = '2003-01-02Z' WHERE id = @atCutoff;
                """, new { old = old.Id, atCutoff = atCutoff.Id }, cancellationToken: Ct));

        Assert.Equal(1, await _repo.DeleteRequestsCreatedBeforeAsync(new DateTimeOffset(2003, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Null(await _repo.GetRequestAsync(old.Id, Ct));
        // Created at the cutoff instant itself is not "before" it.
        Assert.NotNull(await _repo.GetRequestAsync(atCutoff.Id, Ct));
    }

    [Fact]
    public async Task ConnectAsync_SameAppAgain_RevokesThePreviousGrant()
    {
        var (user, first) = await ConnectedAsync();

        await _repo.ConnectAsync(user, Grant(), Ct);

        Assert.DoesNotContain(first.Id, (await _repo.ListLiveAsync(user, Now, Ct)).Select(g => g.Id));
        Assert.Single(await _repo.ListLiveAsync(user, Now, Ct));
    }

    [Fact]
    public async Task ConnectAsync_SameNameOnAnotherHost_KeepsThePreviousGrant()
    {
        var (user, _) = await ConnectedAsync();

        await _repo.ConnectAsync(user, Grant("http://localhost:33418/callback"), Ct);

        Assert.Equal(2, (await _repo.ListLiveAsync(user, Now, Ct)).Count);
    }

    [Fact]
    public async Task ConnectAsync_Alice_LeavesBobsGrantOfTheSameApp()
    {
        var (bob, bobs) = await ConnectedAsync();

        await _repo.ConnectAsync(await db.NewReaderAsync(), Grant(), Ct);

        Assert.Equal(bobs.Id, Assert.Single(await _repo.ListLiveAsync(bob, Now, Ct)).Id);
    }

    [Fact]
    public async Task RotateAsync_CurrentRefreshToken_ReplacesBothTokensAndRemembersTheOld()
    {
        var (_, grant) = await ConnectedAsync();
        var (access, refresh) = (NewHash(), NewHash());

        Assert.True(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, access, Now.AddHours(1), refresh, Now.AddDays(90), Now, Ct));

        var rotated = (await _repo.GetByRefreshTokenAsync(refresh, Ct))!;
        Assert.Equal((access, grant.RefreshTokenHash), (rotated.AccessTokenHash, rotated.PreviousRefreshTokenHash));
        Assert.NotNull(rotated.LastUsedAt);
        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
    }

    [Fact]
    public async Task RotateAsync_RevokedGrant_ReturnsFalse()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Now, Ct);

        Assert.False(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), Now.AddHours(1), NewHash(), Now.AddDays(90), Now, Ct));
    }

    [Fact]
    public async Task GetByRefreshTokenAsync_RevokedGrant_ReturnsNull()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Now, Ct);

        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
    }

    [Fact]
    public async Task RotateAsync_SpentRefreshToken_ReturnsFalse()
    {
        var (_, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), Now.AddHours(1), NewHash(), Now.AddDays(90), Now, Ct);

        Assert.False(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), Now.AddHours(1), NewHash(), Now.AddDays(90), Now, Ct));
    }

    [Fact]
    public async Task RevokeOnRefreshReuseAsync_SpentRefreshToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), Now.AddHours(1), NewHash(), Now.AddDays(90), Now, Ct);

        Assert.Equal(1, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Now, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, Now, Ct));
    }

    [Fact]
    public async Task RevokeOnRefreshReuseAsync_GrantAlreadyRevoked_KeepsTheFirstRevocationTime()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), Now.AddHours(1), NewHash(), Now.AddDays(90), Now, Ct);
        var first = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.RevokeAsync(user, grant.Id, first, Ct);

        Assert.Equal(0, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Now, Ct));

        Assert.Equal(first, await RevokedAtAsync(grant));
    }

    [Fact]
    public async Task RevokeByTokenAsync_RefreshToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();

        Assert.Equal(1, await _repo.RevokeByTokenAsync(grant.RefreshTokenHash, Now, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, Now, Ct));
    }

    [Fact]
    public async Task RevokeByTokenAsync_AccessToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();

        Assert.Equal(1, await _repo.RevokeByTokenAsync(grant.AccessTokenHash, Now, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, Now, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_LiveTokenForTheResource_ReturnsTheGrant()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Equal(grant.Id, (await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, Resource, Now, Ct))?.Id);
    }

    [Fact]
    public async Task GetByAccessTokenAsync_AnotherResource_ReturnsNull()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, "https://elsewhere.test/mcp", Now, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_RevokedGrant_ReturnsNull()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Now, Ct);

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, Resource, Now, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_ExpiredToken_ReturnsNull()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, Resource, Now.AddHours(2), Ct));
    }

    [Fact]
    public async Task TouchAsync_Grant_RecordsTheUse()
    {
        var (user, grant) = await ConnectedAsync();

        await _repo.TouchAsync(grant.Id, Now, Ct);

        Assert.NotNull(Assert.Single(await _repo.ListLiveAsync(user, Now, Ct)).LastUsedAt);
    }

    [Fact]
    public async Task ListLiveAsync_RevokedAndExpiredGrants_AreLeftOut()
    {
        var (user, revoked) = await ConnectedAsync();
        await _repo.RevokeAsync(user, revoked.Id, Now, Ct);
        var expiring = Grant("http://localhost:1/cb");
        expiring.RefreshTokenExpiresAt = Now.AddDays(1);
        await _repo.ConnectAsync(user, expiring, Ct);

        Assert.Empty(await _repo.ListLiveAsync(user, Now.AddDays(2), Ct));
    }

    [Fact]
    public async Task ListLiveAsync_Bob_DoesNotSeeAlicesGrants()
    {
        await ConnectedAsync();

        Assert.Empty(await _repo.ListLiveAsync(await db.NewReaderAsync(), Now, Ct));
    }

    [Fact]
    public async Task RevokeAsync_AlreadyRevoked_KeepsTheFirstRevocationTime()
    {
        var (user, grant) = await ConnectedAsync();
        var first = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.RevokeAsync(user, grant.Id, first, Ct);

        Assert.True(await _repo.RevokeAsync(user, grant.Id, Now, Ct));

        Assert.Equal(first, await RevokedAtAsync(grant));
    }

    private async Task<DateTimeOffset> RevokedAtAsync(OAuthTokenGrant grant)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return await conn.ExecuteScalarAsync<DateTimeOffset>(new CommandDefinition(
            "SELECT revoked_at FROM oauth_grants WHERE id = @Id", grant, cancellationToken: Ct));
    }

    [Fact]
    public async Task RevokeAsync_AnotherUsersGrant_ReturnsFalseAndKeepsIt()
    {
        var (alice, grant) = await ConnectedAsync();

        Assert.False(await _repo.RevokeAsync(await db.NewReaderAsync(), grant.Id, Now, Ct));
        Assert.Single(await _repo.ListLiveAsync(alice, Now, Ct));
    }

    [Fact]
    public async Task DeleteDeadGrantsAsync_RevokedBeforeTheCutoff_DeletesItAndKeepsTheLive()
    {
        var (user, dead) = await ConnectedAsync();
        await _repo.RevokeAsync(user, dead.Id, new DateTimeOffset(2004, 1, 1, 0, 0, 0, TimeSpan.Zero), Ct);
        await _repo.ConnectAsync(user, Grant("http://localhost:2/cb"), Ct);

        Assert.Equal(1, await _repo.DeleteDeadGrantsAsync(new DateTimeOffset(2004, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(1L, await db.CountAsync("oauth_grants", user));
    }
}
