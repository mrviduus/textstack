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
    private const string Secret = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh";
    private const string OtherSecret = "a-DIFFERENT-signing-key-long-enough-for-hmac-sha256-xyz";
    private const string Issuer = "textstack.app";

    private static AuthService Service() => new(
        db: null!,
        jwtSettings: Options.Create(new JwtSettings { SecretKey = Secret, Issuer = Issuer }),
        googleSettings: Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" }));

    /// <summary>Mints a token the same shape <c>AuthService.GenerateAccessToken</c> does.</summary>
    private static string Token(
        Guid? userId,
        bool guestClaim,
        string? guestClaimValue = "true",
        string issuer = Issuer,
        string secret = Secret,
        int expiresInMinutes = 60)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.Email, "reader@example.test"),
            new(ClaimTypes.Name, "Reader"),
        };
        if (userId is { } id) claims.Insert(0, new Claim(ClaimTypes.NameIdentifier, id.ToString()));
        if (guestClaim) claims.Add(new Claim(AuthService.GuestClaimType, guestClaimValue!));

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var token = new JwtSecurityToken(
            issuer: issuer,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(expiresInMinutes),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_GuestToken_ReportsTheUserAndTheGuestFlag()
    {
        var id = Guid.NewGuid();

        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(Token(id, guestClaim: true));

        Assert.Equal(id, userId);
        Assert.True(isGuest);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_AccountToken_ReportsTheUserAndNotAGuest()
    {
        // The middleware must not write LastActiveAt for an account: the column is only read by
        // GuestCleanupWorker, and an UPDATE per request on every signed-in reader is pure cost.
        var id = Guid.NewGuid();

        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(Token(id, guestClaim: false));

        Assert.Equal(id, userId);
        Assert.False(isGuest);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_ExpiredGuestToken_IsNobody()
    {
        // The documented contract: (null, false) rather than an id, so no caller can mistake an
        // expired token for an account. `ClockSkew = Zero`, so one minute in the past is expired.
        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, expiresInMinutes: -1));

        Assert.Null(userId);
        Assert.False(isGuest);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_ForeignSignature_IsNobody()
    {
        // Structurally a real guest token, signed with a key this deployment does not hold.
        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, secret: OtherSecret));

        Assert.Null(userId);
        Assert.False(isGuest);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_WrongIssuer_IsNobody()
    {
        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(
            Token(Guid.NewGuid(), guestClaim: true, issuer: "someone-elses.app"));

        Assert.Null(userId);
        Assert.False(isGuest);
    }

    [Fact]
    public void ValidateAccessTokenIdentity_NoSubjectClaim_IsNobody()
    {
        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(
            Token(userId: null, guestClaim: true));

        Assert.Null(userId);
        Assert.False(isGuest);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("True")]   // the claim is compared with ==, so casing matters
    [InlineData("1")]
    [InlineData("")]
    public void ValidateAccessTokenIdentity_GuestClaimThatIsNotExactlyTrue_IsNotAGuest(string value)
    {
        var id = Guid.NewGuid();

        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(
            Token(id, guestClaim: true, guestClaimValue: value));

        Assert.Equal(id, userId);
        Assert.False(isGuest);
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
        var (userId, isGuest) = Service().ValidateAccessTokenIdentity(token);

        Assert.Null(userId);
        Assert.False(isGuest);
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

        Assert.Equal(service.ValidateAccessToken(guest), service.ValidateAccessTokenIdentity(guest).UserId);
        Assert.Equal(service.ValidateAccessToken(account), service.ValidateAccessTokenIdentity(account).UserId);
        Assert.Equal(service.ValidateAccessToken(dead), service.ValidateAccessTokenIdentity(dead).UserId);
    }
}
