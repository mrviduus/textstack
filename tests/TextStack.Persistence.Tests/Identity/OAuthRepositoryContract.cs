using Application.Identity;
using Domain.Identity;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="IOAuthRepository"/>'s contract (ADR-017: an assistant connects to a reader's library),
/// run against V2 by <see cref="OAuthRepositoryTests"/>.
/// </summary>
public abstract class OAuthRepositoryContract(IIdentityFixture db, IOAuthRepository repo)
{
    private readonly IOAuthRepository _repo = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    protected async Task<OAuthAuthorization> CreatedRequestAsync()
    {
        var request = NewOAuthRequest();
        await _repo.CreateRequestAsync(request, Ct);
        return request;
    }

    /// <summary>An OAuth request the user approved just now (what a grant is connected for); its id.</summary>
    protected async Task<Guid> ApprovedRequestAsync(Guid userId)
    {
        var request = await CreatedRequestAsync();
        await ApproveAsync(request.Id, userId);
        return request.Id;
    }

    private Task<OAuthAuthorization?> ApproveAsync(Guid requestId, Guid userId, string? code = null) =>
        _repo.ApproveRequestAsync(requestId, userId, code ?? NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

    private async Task<(Guid User, OAuthTokenGrant Grant)> ConnectedAsync()
    {
        var user = await db.NewReaderAsync();
        var grant = NewGrant();
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), grant, Ct);
        return (user, grant);
    }

    private Task<bool> RotateAsync(OAuthTokenGrant grant, string? access = null, string? refresh = null) =>
        _repo.RotateAsync(grant.Id, grant.RefreshTokenHash, access ?? NewHash(), DateTimeOffset.UtcNow.AddHours(1), refresh ?? NewHash(), DateTimeOffset.UtcNow.AddDays(90), Ct);

    private Task<IReadOnlyList<OAuthTokenGrant>> LiveAsync(Guid user) => _repo.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct);

    private Task<long> StoredAsync(OAuthTokenGrant grant) =>
        db.ScalarAsync<long>("SELECT count(*) FROM oauth_grants WHERE id = @Id", grant);

    private Task<DateTimeOffset> RevokedAtAsync(OAuthTokenGrant grant) =>
        db.ScalarAsync<DateTimeOffset>("SELECT revoked_at FROM oauth_grants WHERE id = @Id", grant);

    [Fact]
    public async Task SaveClientAsync_AppRegistersThenRefetchesItsMetadata_StoresThenRefreshesTheClient()
    {
        var clientId = "tsc_" + Guid.NewGuid();
        var saved = await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = clientId, ClientName = "Claude", RedirectUris = ["https://claude.ai/cb"] }, Ct);

        var stored = (await _repo.GetClientAsync(clientId, Ct))!;
        Assert.Equal((stored.Id, stored.ClientName, false), (saved.Id, saved.ClientName, saved.IsMetadataDocument));
        Assert.Equal(stored.CreatedAt, saved.CreatedAt, TimeSpan.FromMilliseconds(1));

        // A metadata-document client fetched again: same client id, the new name and redirects win.
        var url = $"https://client.test/{Guid.NewGuid()}.json";
        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "Old", RedirectUris = ["https://a.test/cb"], IsMetadataDocument = true }, Ct);
        await _repo.SaveClientAsync(new() { Id = Guid.NewGuid(), ClientId = url, ClientName = "New", RedirectUris = ["https://b.test/cb"], IsMetadataDocument = true, FetchedAt = DateTimeOffset.UtcNow }, Ct);

        var refreshed = (await _repo.GetClientAsync(url, Ct))!;
        Assert.Equal(("New", "https://b.test/cb"), (refreshed.ClientName, Assert.Single(refreshed.RedirectUris)));
        Assert.NotNull(refreshed.FetchedAt);
    }

    [Fact]
    public async Task ApproveRequestAsync_AliceConsents_BindsHerAndTheCodeAndNoOneCanDecideAgain()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var request = await CreatedRequestAsync();
        var code = NewHash();

        var approved = (await ApproveAsync(request.Id, alice, code))!;

        Assert.Equal((alice, code), (approved.UserId!.Value, approved.CodeHash));
        Assert.Equal(request.Id, (await _repo.GetRequestByCodeAsync(code, Ct))?.Id);
        // Decided once: Bob cannot take it over, and a late "deny" does not undo the approval.
        Assert.Null(await ApproveAsync(request.Id, bob));
        Assert.False(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));
        var after = (await _repo.GetRequestAsync(request.Id, Ct))!;
        Assert.Equal(alice, after.UserId);
        Assert.Null(after.DeniedAt);
    }

    [Fact]
    public async Task ApproveRequestAsync_UnknownUserDeniedOrPastTheDeadline_ReturnsNullAndBindsNoOne()
    {
        var reader = await db.NewReaderAsync();
        var (forUnknownUser, denied, late) = (await CreatedRequestAsync(), await CreatedRequestAsync(), await CreatedRequestAsync());
        await _repo.DenyRequestAsync(denied.Id, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await ApproveAsync(forUnknownUser.Id, Guid.NewGuid()));
        Assert.Null(await ApproveAsync(denied.Id, reader));
        // The consent page opened 30 minutes past its 30-minute deadline.
        Assert.Null(await _repo.ApproveRequestAsync(late.Id, reader, NewHash(), DateTimeOffset.UtcNow.AddHours(2), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1), Ct));

        foreach (var request in new[] { forUnknownUser, denied, late })
            Assert.Null((await _repo.GetRequestAsync(request.Id, Ct))!.UserId);
    }

    [Fact]
    public async Task DenyRequestAsync_ReaderRefuses_DeniesOnceAndNeverPastTheDeadline()
    {
        var (request, late) = (await CreatedRequestAsync(), await CreatedRequestAsync());

        Assert.True(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));

        Assert.NotNull((await _repo.GetRequestAsync(request.Id, Ct))!.DeniedAt);
        Assert.False(await _repo.DenyRequestAsync(request.Id, DateTimeOffset.UtcNow, Ct));
        Assert.False(await _repo.DenyRequestAsync(late.Id, DateTimeOffset.UtcNow.AddHours(1), Ct));
        Assert.Null((await _repo.GetRequestAsync(late.Id, Ct))!.DeniedAt);
    }

    [Fact]
    public async Task BurnCodeAsync_CodeRedeemedTwice_OnlyTheFirstWins()
    {
        var requestId = await ApprovedRequestAsync(await db.NewReaderAsync());

        Assert.True(await _repo.BurnCodeAsync(requestId, Ct));

        Assert.False(await _repo.BurnCodeAsync(requestId, Ct));
        Assert.NotNull((await _repo.GetRequestAsync(requestId, Ct))!.ConsumedAt);
    }

    [Fact]
    public async Task DeleteRequestsCreatedBeforeAsync_Cutoff_DeletesOnlyOlderRequests()
    {
        var (old, atCutoff) = (await CreatedRequestAsync(), await CreatedRequestAsync());
        await db.ExecAsync("""
            UPDATE oauth_authorization_requests SET created_at = '2003-01-01Z' WHERE id = @old;
            UPDATE oauth_authorization_requests SET created_at = '2003-01-02Z' WHERE id = @atCutoff;
            """, new { old = old.Id, atCutoff = atCutoff.Id });

        Assert.Equal(1, await _repo.DeleteRequestsCreatedBeforeAsync(new DateTimeOffset(2003, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Null(await _repo.GetRequestAsync(old.Id, Ct));
        // Created at the cutoff instant itself is not "before" it.
        Assert.NotNull(await _repo.GetRequestAsync(atCutoff.Id, Ct));
    }

    [Fact]
    public async Task ConnectAsync_SameAppAgain_ReplacesTheGrantOfThatHostOnly()
    {
        var (user, first) = await ConnectedAsync();
        var second = NewGrant();

        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), second, Ct);

        Assert.Equal(second.Id, Assert.Single(await LiveAsync(user)).Id);

        // "Claude" on localhost (Claude Code) is another app to the reader: both stay connected.
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), NewGrant("http://localhost:33418/callback"), Ct);

        var live = (await LiveAsync(user)).Select(g => g.Id).ToList();
        Assert.Equal(2, live.Count);
        Assert.Contains(second.Id, live);
        Assert.DoesNotContain(first.Id, live);
    }

    [Fact]
    public async Task ConnectAsync_BobHoldingAlicesIds_TouchesNothingOfHers()
    {
        var (alice, alices) = await ConnectedAsync();
        var bob = await db.NewReaderAsync();

        Assert.Empty(await LiveAsync(bob));
        Assert.False(await _repo.ConnectAsync(bob, await ApprovedRequestAsync(alice), NewGrant(), Ct));
        Assert.Equal(0L, await db.CountAsync("oauth_grants", bob));
        Assert.False(await _repo.RevokeAsync(bob, alices.Id, Ct));
        // Bob connecting the same app with his own consent leaves Alice's grant live.
        Assert.True(await _repo.ConnectAsync(bob, await ApprovedRequestAsync(bob), NewGrant(), Ct));

        Assert.Equal(alices.Id, Assert.Single(await LiveAsync(alice)).Id);
    }

    [Fact]
    public async Task RotateAsync_AppRefreshes_ReplacesBothTokensAndAReplayedOldTokenRevokesTheGrant()
    {
        var (user, grant) = await ConnectedAsync();
        var (access, refresh) = (NewHash(), NewHash());

        Assert.True(await RotateAsync(grant, access, refresh));

        var rotated = (await _repo.GetByRefreshTokenAsync(refresh, Ct))!;
        Assert.Equal((access, grant.RefreshTokenHash), (rotated.AccessTokenHash, rotated.PreviousRefreshTokenHash));
        Assert.NotNull(rotated.LastUsedAt);
        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
        // The spent token again: refused, and treated as theft (RFC 6819 5.2.2.3) - the grant dies.
        Assert.False(await RotateAsync(grant));
        Assert.Equal(1, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Ct));
        Assert.Empty(await LiveAsync(user));
        var first = await RevokedAtAsync(grant);

        Assert.Equal(0, await _repo.RevokeOnRefreshReuseAsync(grant.RefreshTokenHash, Ct));
        Assert.Equal(first, await RevokedAtAsync(grant));

        // A grant the reader already revoked by hand: the replay finds nothing live, the hand revocation time stays.
        var (owner, handRevoked) = await ConnectedAsync();
        Assert.True(await RotateAsync(handRevoked));
        Assert.True(await _repo.RevokeAsync(owner, handRevoked.Id, Ct));
        var byHand = await RevokedAtAsync(handRevoked);

        Assert.Equal(0, await _repo.RevokeOnRefreshReuseAsync(handRevoked.RefreshTokenHash, Ct));
        Assert.Equal(byHand, await RevokedAtAsync(handRevoked));
    }

    [Fact]
    public async Task GetByAccessTokenAsync_McpCall_FindsTheGrantOnlyForALiveTokenOfThisResource()
    {
        var (user, grant) = await ConnectedAsync();
        Assert.Null(Assert.Single(await LiveAsync(user)).LastUsedAt);

        Assert.Equal(grant.Id, (await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow, Ct))?.Id);
        await _repo.TouchAsync(grant.Id, Ct);

        Assert.NotNull(Assert.Single(await LiveAsync(user)).LastUsedAt);
        // RFC 8707: a token minted for this MCP server is no good elsewhere; and it lives an hour.
        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, "https://elsewhere.test/mcp", DateTimeOffset.UtcNow, Ct));
        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow.AddHours(2), Ct));
    }

    [Fact]
    public async Task RevokeAsync_ReaderDisconnectsTheApp_EveryTokenStopsAndTheFirstRevocationTimeStays()
    {
        var (user, grant) = await ConnectedAsync();
        var expiring = NewGrant("http://localhost:1/cb");
        expiring.RefreshTokenExpiresAt = DateTimeOffset.UtcNow.AddDays(1);
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), expiring, Ct);

        Assert.True(await _repo.RevokeAsync(user, grant.Id, Ct));

        Assert.Null(await _repo.GetByAccessTokenAsync(grant.AccessTokenHash, OAuthResource, DateTimeOffset.UtcNow, Ct));
        Assert.Null(await _repo.GetByRefreshTokenAsync(grant.RefreshTokenHash, Ct));
        Assert.False(await RotateAsync(grant));
        // Left: the other grant, until its refresh token expires.
        Assert.Equal(expiring.Id, Assert.Single(await LiveAsync(user)).Id);
        Assert.Empty(await _repo.ListLiveAsync(user, DateTimeOffset.UtcNow.AddDays(2), Ct));
        var first = await RevokedAtAsync(grant);

        Assert.True(await _repo.RevokeAsync(user, grant.Id, Ct));
        Assert.Equal(first, await RevokedAtAsync(grant));
    }

    [Fact]
    public async Task RevokeByTokenAsync_AppRevokesItsAccessOrRefreshToken_RevokesTheGrant()
    {
        var (byRefreshUser, byRefresh) = await ConnectedAsync();
        var (byAccessUser, byAccess) = await ConnectedAsync();

        Assert.Equal(1, await _repo.RevokeByTokenAsync(byRefresh.RefreshTokenHash, Ct));
        Assert.Equal(1, await _repo.RevokeByTokenAsync(byAccess.AccessTokenHash, Ct));

        Assert.Empty(await LiveAsync(byRefreshUser));
        Assert.Empty(await LiveAsync(byAccessUser));
    }

    [Fact]
    public async Task DeleteDeadGrantsAsync_Cutoff_DeletesTheRevokedAndTheExpiredAndKeepsTheLive()
    {
        var user = await db.NewReaderAsync();
        // Never revoked, its refresh token long dead. The sweep is global over a shared database, so
        // the test asserts only its own rows, by id.
        var expired = NewGrant("http://localhost:2/cb");
        expired.RefreshTokenExpiresAt = new DateTimeOffset(2004, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), expired, Ct);
        var revoked = NewGrant("http://127.0.0.1:3/cb"); // another host, so connecting it leaves `expired` unrevoked
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), revoked, Ct);
        // Revocation is stamped by the database; the test backdates it past the cutoff.
        await db.ExecAsync("UPDATE oauth_grants SET revoked_at = '2004-01-01Z' WHERE id = @Id", revoked);
        var live = NewGrant();
        await _repo.ConnectAsync(user, await ApprovedRequestAsync(user), live, Ct);
        Assert.Equal((1L, 1L, 1L), (await StoredAsync(expired), await StoredAsync(revoked), await StoredAsync(live)));

        await _repo.DeleteDeadGrantsAsync(new DateTimeOffset(2004, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct);

        Assert.Equal(0L, await StoredAsync(expired));
        Assert.Equal(0L, await StoredAsync(revoked));
        Assert.Equal(1L, await StoredAsync(live));
    }
}
