using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

public class OAuthRepositoryTests(V2PostgresFixture db)
{
    private readonly OAuthRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<OAuthAuthorization> CreatedRequestAsync()
    {
        var request = NewOAuthRequest();
        await _repo.CreateRequestAsync(request, Ct);
        return request;
    }

    private async Task<(Guid User, OAuthTokenGrant Grant)> ConnectedAsync()
    {
        var user = await db.NewReaderAsync();
        var grant = NewGrant();
        await _repo.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), grant, Ct);
        return (user, grant);
    }

    [Fact]
    public async Task SaveClientAsync_SameClientIdAgain_RefreshesTheRegistration()
    {
        var url = $"https://client.test/{Guid.NewGuid()}.json";
        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "Old", RedirectUris = ["https://a.test/cb"], IsMetadataDocument = true }, Ct);

        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "New", RedirectUris = ["https://b.test/cb"], IsMetadataDocument = true, FetchedAt = DateTimeOffset.UtcNow }, Ct);

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

        var approved = (await _repo.ApproveRequestAsync(request.Id, user, code, DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct))!;

        Assert.Equal((user, code), (approved.UserId!.Value, approved.CodeHash));
        Assert.Equal(request.Id, (await _repo.GetRequestByCodeAsync(code, Ct))?.Id);
    }

    [Fact]
    public async Task ApproveRequestAsync_AlreadyApproved_ReturnsNullAndKeepsTheFirstUser()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, alice, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, bob, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.Equal(alice, (await _repo.GetRequestAsync(request.Id, Ct))!.UserId);
    }

    [Fact]
    public async Task ApproveRequestAsync_Denied_ReturnsNull()
    {
        var request = await CreatedRequestAsync();
        await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task ApproveRequestAsync_PastTheConsentDeadline_ReturnsNull()
    {
        var request = await CreatedRequestAsync();

        Assert.Null(await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), DateTimeOffset.UtcNow.AddHours(2), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1), Ct));
    }

    [Fact]
    public async Task DenyRequestAsync_Pending_DeniesItOnce()
    {
        var request = await CreatedRequestAsync();

        Assert.True(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));

        Assert.NotNull((await _repo.GetRequestAsync(request.Id, Ct))!.DeniedAt);
        Assert.False(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DenyRequestAsync_Approved_ReturnsFalseAndKeepsTheApproval()
    {
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.False(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));
        Assert.Null((await _repo.GetRequestAsync(request.Id, Ct))!.DeniedAt);
    }

    [Fact]
    public async Task DenyRequestAsync_PastTheConsentDeadline_ReturnsFalse()
    {
        var request = await CreatedRequestAsync();

        Assert.False(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow.AddHours(1), Ct));
    }

    [Fact]
    public async Task BurnCodeAsync_SecondRedemption_ReturnsFalse()
    {
        var request = await CreatedRequestAsync();
        await _repo.ApproveRequestAsync(request.Id, await db.NewReaderAsync(), NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.True(await _repo.BurnCodeAsync(request.Id, Ct));

        Assert.False(await _repo.BurnCodeAsync(request.Id, Ct));
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

        await _repo.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), NewGrant(), Ct);

        Assert.DoesNotContain(first.Id, (await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct)).Select(g => g.Id));
        Assert.Single(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task ConnectAsync_SameNameOnAnotherHost_KeepsThePreviousGrant()
    {
        var (user, _) = await ConnectedAsync();

        await _repo.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), NewGrant("http://localhost:33418/callback"), Ct);

        Assert.Equal(2, (await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct)).Count);
    }

    [Fact]
    public async Task ConnectAsync_Alice_LeavesBobsGrantOfTheSameApp()
    {
        var (bob, bobs) = await ConnectedAsync();

        var alice = await db.NewReaderAsync();
        await _repo.ConnectAsync(alice, await db.ApprovedOAuthRequestAsync(alice), NewGrant(), Ct);

        Assert.Equal(bobs.Id, Assert.Single(await _repo.ListLiveAsync(bob, DateTimeOffset.UtcNow, Ct)).Id);
    }

    [Fact]
    public async Task RotateAsync_CurrentRefreshToken_ReplacesBothTokensAndRemembersTheOld()
    {
        var (_, grant) = await ConnectedAsync();
        var (access, refresh) = (NewHash(), NewHash());

        Assert.True(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, access, DateTimeOffset.UtcNow.AddHours(1), refresh, DateTimeOffset.UtcNow.AddDays(90), Ct));

        var rotated = (await _repo.GetByRefreshTokenAsync(refresh, Ct))!;
        Assert.Equal((access, grant.RefreshTokenHash), (rotated.AccessTokenHash, rotated.PreviousRefreshTokenHash));
        Assert.NotNull(rotated.LastUsedAt);
        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
    }

    [Fact]
    public async Task RotateAsync_RevokedGrant_ReturnsFalse()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Ct);

        Assert.False(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), DateTimeOffset.UtcNow.AddHours(1), NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct));
    }

    [Fact]
    public async Task GetByRefreshTokenAsync_RevokedGrant_ReturnsNull()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Ct);

        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
    }

    [Fact]
    public async Task RotateAsync_SpentRefreshToken_ReturnsFalse()
    {
        var (_, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), DateTimeOffset.UtcNow.AddHours(1), NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct);

        Assert.False(await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), DateTimeOffset.UtcNow.AddHours(1), NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct));
    }

    [Fact]
    public async Task RevokeOnRefreshReuseAsync_SpentRefreshToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), DateTimeOffset.UtcNow.AddHours(1), NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct);

        Assert.Equal(1, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeOnRefreshReuseAsync_GrantAlreadyRevoked_KeepsTheFirstRevocationTime()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, NewHash(), DateTimeOffset.UtcNow.AddHours(1), NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct);
        await _repo.RevokeAsync(user, grant.Id, Ct);
        var first = await RevokedAtAsync(grant);

        Assert.Equal(0, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Ct));

        Assert.Equal(first, await RevokedAtAsync(grant));
    }

    [Fact]
    public async Task RevokeByTokenAsync_RefreshToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();

        Assert.Equal(1, await _repo.RevokeByTokenAsync(grant.RefreshTokenHash, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeByTokenAsync_AccessToken_RevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();

        Assert.Equal(1, await _repo.RevokeByTokenAsync(grant.AccessTokenHash, Ct));

        Assert.Empty(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_LiveTokenForTheResource_ReturnsTheGrant()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Equal(grant.Id, (await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow, Ct))?.Id);
    }

    [Fact]
    public async Task GetByAccessTokenAsync_AnotherResource_ReturnsNull()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, "https://elsewhere.test/mcp", DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_RevokedGrant_ReturnsNull()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Ct);

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_ExpiredToken_ReturnsNull()
    {
        var (_, grant) = await ConnectedAsync();

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow.AddHours(2), Ct));
    }

    [Fact]
    public async Task TouchAsync_Grant_RecordsTheUse()
    {
        var (user, grant) = await ConnectedAsync();

        await _repo.TouchAsync(grant.Id, Ct);

        Assert.NotNull(Assert.Single(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct)).LastUsedAt);
    }

    [Fact]
    public async Task ListLiveAsync_RevokedAndExpiredGrants_AreLeftOut()
    {
        var (user, revoked) = await ConnectedAsync();
        await _repo.RevokeAsync(user, revoked.Id, Ct);
        var expiring = NewGrant("http://localhost:1/cb");
        expiring.RefreshTokenExpiresAt = DateTimeOffset.UtcNow.AddDays(1);
        await _repo.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), expiring, Ct);

        Assert.Empty(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow.AddDays(2), Ct));
    }

    [Fact]
    public async Task ListLiveAsync_Bob_DoesNotSeeAlicesGrants()
    {
        await ConnectedAsync();

        Assert.Empty(await _repo.ListLiveAsync(await db.NewReaderAsync(), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeAsync_AlreadyRevoked_KeepsTheFirstRevocationTime()
    {
        var (user, grant) = await ConnectedAsync();
        await _repo.RevokeAsync(user, grant.Id, Ct);
        var first = await RevokedAtAsync(grant);

        Assert.True(await _repo.RevokeAsync(user, grant.Id, Ct));

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

        Assert.False(await _repo.RevokeAsync(await db.NewReaderAsync(), grant.Id, Ct));
        Assert.Single(await _repo.ListLiveAsync(alice, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DeleteDeadGrantsAsync_RevokedBeforeTheCutoff_DeletesItAndKeepsTheLive()
    {
        var (user, dead) = await ConnectedAsync();
        // Revocation is stamped by the database; the test backdates it past the cutoff.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE oauth_grants SET revoked_at = '2004-01-01Z' WHERE id = @Id", dead, cancellationToken: Ct));
        await _repo.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), NewGrant("http://localhost:2/cb"), Ct);

        Assert.Equal(1, await _repo.DeleteDeadGrantsAsync(new DateTimeOffset(2004, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(1L, await db.CountAsync("oauth_grants", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_OAuthCodeApprovedBefore_ExpiresItAndMintsNoGrant()
    {
        // The device-login twin: an approved request whose code is not yet exchanged dies with the reset.
        var user = await db.NewReaderAsync();
        var requestId = await db.ApprovedOAuthRequestAsync(user);
        var sessions = new SessionTokenRepository(db.DataSource);
        var resetCode = NewHash();
        await sessions.CreatePasswordResetAsync(user, resetCode, DateTimeOffset.UtcNow.AddHours(1), Ct);

        Assert.NotNull(await sessions.ResetPasswordAsync(resetCode, "new-hash", DateTimeOffset.UtcNow, Ct));

        Assert.Equal(0L, await db.ScalarAsync<long>(
            "SELECT count(*) FROM oauth_authorization_requests WHERE id = @requestId AND expires_at > now()", new { requestId }));
        Assert.False(await _repo.ConnectAsync(user, requestId, NewGrant(), Ct));
        Assert.Equal(0L, await db.CountAsync("oauth_grants", user));
    }

    [Fact]
    public async Task ApproveRequestAsync_TokenFromBeforeTheReset_ReturnsNullAndStaysPending()
    {
        var (user, request) = (await db.NewReaderAsync(), await CreatedRequestAsync());
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);

        Assert.Null(await _repo.ApproveRequestAsync(
            request.Id, user, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, Ct));
        Assert.Null((await _repo.GetRequestAsync(request.Id, Ct))!.UserId);
    }

    [Fact]
    public async Task ConnectAsync_ResetCommitsWhileItWaits_StoresNoGrant()
    {
        // A reset holding the user has stamped it, not yet committed: the exchange of a code approved
        // before it waits, then refuses.
        var user = await db.NewReaderAsync();
        var requestId = await db.ApprovedOAuthRequestAsync(user);

        var (waited, connected) = await db.WhileUserHeldAsync(user, "UPDATE users SET credentials_reset_at = clock_timestamp() WHERE id = @user;",
            () => _repo.ConnectAsync(user, requestId, NewGrant(), Ct));

        Assert.True(waited);
        Assert.False(connected);
        Assert.Equal(0L, await db.CountAsync("oauth_grants", user));
    }

    [Fact]
    public async Task ConnectAsync_AnotherUsersRequest_StoresNoGrant()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var alicesRequest = await db.ApprovedOAuthRequestAsync(alice);

        Assert.False(await _repo.ConnectAsync(bob, alicesRequest, NewGrant(), Ct));
        Assert.Equal(0L, await db.CountAsync("oauth_grants", bob));
    }
}
