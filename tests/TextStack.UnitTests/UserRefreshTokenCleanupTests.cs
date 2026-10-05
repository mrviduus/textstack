using Domain.Entities;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily cleanup deletes user refresh tokens a day past expiry, never a live one.</summary>
public class UserRefreshTokenCleanupTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    private static bool IsDeleted(DateTimeOffset expiresAt) =>
        AdminRefreshTokenCleanupWorker.ExpiredUserToken(Now).Compile()(
            new UserRefreshToken { TokenHash = "h", ExpiresAt = expiresAt });

    [Fact]
    public void ExpiredUserToken_ExpiredOverADayAgo_Deleted() =>
        Assert.True(IsDeleted(Now.AddDays(-1).AddSeconds(-1)));

    [Fact]
    public void ExpiredUserToken_ExpiredWithinGrace_Kept() =>
        Assert.False(IsDeleted(Now.AddHours(-23)));

    [Fact]
    public void ExpiredUserToken_StillValid_Kept() =>
        Assert.False(IsDeleted(Now.AddDays(30)));
}
