using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The contract on V2, and what only V2 has: the password-reset stamp (#1092).</summary>
public class OAuthRepositoryTests(PostgresFixture db) : OAuthRepositoryContract(db, new OAuthRepository(db.DataSource))
{
    private readonly OAuthRepository _repo = new(db.DataSource);

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

    [Theory]
    // The api's clock 3 minutes behind the database's: the reset came after the consent was asked.
    [InlineData(-3, -2, false)]
    // 3 minutes ahead: the consent was asked after the reset.
    [InlineData(3, 2, true)]
    public async Task ConnectAsync_ApiClockSkewedFromTheDatabase_ComparesConsentAndResetOnTheApisClock(
        int requestedAtMinutes, int resetAtMinutes, bool expected)
    {
        // #1364: both stamps come from the api's clock, so the database's clock never decides.
        var user = await db.NewReaderAsync();
        var request = NewOAuthRequest();
        request.CreatedAt = DateTimeOffset.UtcNow.AddMinutes(requestedAtMinutes);
        await _repo.CreateRequestAsync(request, Ct);
        await _repo.ApproveRequestAsync(request.Id, user, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow.AddMinutes(10), DateTimeOffset.UtcNow, Ct);
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow.AddMinutes(resetAtMinutes));

        Assert.Equal(expected, await _repo.ConnectAsync(user, request.Id, NewGrant(), Ct));
        Assert.Equal(expected ? 1L : 0L, await db.CountAsync("oauth_grants", user));
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
}
