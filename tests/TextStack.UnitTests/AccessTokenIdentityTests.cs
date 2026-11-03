using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Application.Auth;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests;

/// <summary>
/// <c>AuthService.ValidateAccessTokenIdentity</c> — the seam #604 added so
/// <c>GuestActivityMiddleware</c> could learn, from the token, whether a request belongs to a guest.
///
/// <para>The middleware got a pure function and tests for its <b>debounce</b>
/// (<c>GuestActivityDebounceTests</c>). The part that was actually broken — deciding whether this is
/// a guest — got neither. It is the whole reason the middleware was inert for a year: the answer was
/// being read from <c>HttpContext.User</c>, which this API never populates. Reading it from the
/// right place is a claim that should be pinned, not re-verified by hand each time.</para>
///
/// <para>No database is touched by the method under test, so <c>IAppDbContext</c> is not supplied.</para>
/// </summary>
public class AccessTokenIdentityTests
{
    private const string Secret = TestTokens.Secret;
    private const string OtherSecret = "a-DIFFERENT-signing-key-long-enough-for-hmac-sha256-xyz";
    private const string Issuer = TestTokens.Issuer;

    private static AuthService Service() => new(
        db: null!,
        jwtSettings: Options.Create(new JwtSettings { SecretKey = Secret, Issuer = Issuer }),
        googleSettings: Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" }));

    private static string Token(
        Guid? userId, bool guestClaim, string? guestClaimValue = "true", string issuer = Issuer, string secret = Secret,
        int expiresInMinutes = 60, string? audience = JwtSettings.UserAudience, string algorithm = SecurityAlgorithms.HmacSha256) =>
        TestTokens.Token(userId, guestClaim, guestClaimValue, issuer, secret, expiresInMinutes, audience, algorithm);

    [Fact]
    public void ValidateAccessTokenIdentity_GuestToken_ReportsTheUserAndTheGuestFlag()
    {
        var id = Guid.NewGuid();

        var identity = Service().ValidateAccessTokenIdentity(Token(id, guestClaim: true))!;

        Assert.Equal((id, true), (identity.UserId, identity.IsGuest));
    }

    [Fact]
    public void ValidateAccessTokenIdentity_AccountToken_ReportsTheUserAndNotAGuest()
    {
        // The middleware must not write LastActiveAt for an account: the column is only read by
        // GuestCleanupWorker, and an UPDATE per request on every signed-in reader is pure cost.
        var id = Guid.NewGuid();

        var identity = Service().ValidateAccessTokenIdentity(Token(id, guestClaim: false))!;

        Assert.Equal((id, false), (identity.UserId, identity.IsGuest));
    }

    [Fact]
    public void ValidateAccessTokenIdentity_ExpiredGuestToken_IsNobody()
    {
        // The documented contract: null rather than an id, so no caller can mistake an
        // expired token for an account. `ClockSkew = Zero`, so one minute in the past is expired.
        Assert.Null(Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, expiresInMinutes: -1)));
    }

    [Fact]
    public void ValidateAccessTokenIdentity_ForeignSignature_IsNobody()
    {
        // Structurally a real guest token, signed with a key this deployment does not hold.
        Assert.Null(Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, secret: OtherSecret)));
    }

    [Fact]
    public void ValidateAccessTokenIdentity_WrongIssuer_IsNobody()
    {
        Assert.Null(Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, issuer: "someone-elses.app")));
    }

    [Theory]
    [InlineData(null)]                          // pre-audience token
    [InlineData(JwtSettings.AdminAudience)]     // an admin-panel token
    [InlineData("someone-elses-api")]
    public void ValidateAccessTokenIdentity_NotTheUserAudience_IsNobody(string? audience)
    {
        Assert.Null(Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: false, audience: audience)));
    }

    [Theory]
    [InlineData(SecurityAlgorithms.HmacSha256, true)]
    [InlineData(SecurityAlgorithms.HmacSha512, false)]
    public void ValidateAccessTokenIdentity_SameKeyOtherAlgorithm_OnlyHs256Accepted(string algorithm, bool accepted)
    {
        // HS512 needs a 64-byte key, so both cases use one long enough for either.
        const string longSecret = Secret + Secret;
        var service = new AuthService(
            db: null!,
            jwtSettings: Options.Create(new JwtSettings { SecretKey = longSecret, Issuer = Issuer }),
            googleSettings: Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" }));
        var id = Guid.NewGuid();

        var userId = service.ValidateAccessTokenIdentity(
            Token(id, guestClaim: false, secret: longSecret, algorithm: algorithm))?.UserId;

        Assert.Equal(accepted ? id : null, userId);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_NoSubjectClaim_IsNobody()
    {
        Assert.Null(Service().ValidateAccessTokenIdentity(
            Token(userId: null, guestClaim: true)));
    }

    [Theory]
    [InlineData("false")]
    [InlineData("True")]   // the claim is compared with ==, so casing matters
    [InlineData("1")]
    [InlineData("")]
    public void ValidateAccessTokenIdentity_GuestClaimThatIsNotExactlyTrue_IsNotAGuest(string value)
    {
        var id = Guid.NewGuid();

        var identity = Service().ValidateAccessTokenIdentity(
            Token(id, guestClaim: true, guestClaimValue: value))!;

        Assert.Equal((id, false), (identity.UserId, identity.IsGuest));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-jwt")]
    [InlineData("tsk_a_connect_key_is_not_a_jwt")]   // McpKeyAuthMiddleware's bearer reaches here too
    [InlineData("a.b.c")]
    public void ValidateAccessTokenIdentity_Garbage_IsNobodyAndDoesNotThrow(string token)
    {
        // A connect key is an account-level credential and never a guest's; it must fall through
        // quietly rather than throw inside a middleware that runs on every request.
        Assert.Null(Service().ValidateAccessTokenIdentity(token));
    }

    [Fact]
    public void ValidateAccessToken_AndTheIdentityOverload_CannotDisagree()
    {
        // One is defined in terms of the other precisely so the guest-activity path and every
        // endpoint's GetUserId resolve the same user. Pinned so an optimisation cannot split them.
        var service = Service();
        var id = Guid.NewGuid();
        var guest = Token(id, guestClaim: true);
        var account = Token(id, guestClaim: false);
        var dead = Token(id, guestClaim: true, expiresInMinutes: -1);

        Assert.Equal(service.ValidateAccessToken(guest), service.ValidateAccessTokenIdentity(guest)?.UserId);
        Assert.Equal(service.ValidateAccessToken(account), service.ValidateAccessTokenIdentity(account)?.UserId);
        Assert.Equal(service.ValidateAccessToken(dead), service.ValidateAccessTokenIdentity(dead)?.UserId);
    }
}
