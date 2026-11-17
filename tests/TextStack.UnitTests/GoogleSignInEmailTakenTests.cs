using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Moq;
using Npgsql;

namespace TextStack.UnitTests;

/// <summary>A Google sign-in whose email another account holds is refused (null → 401), never a 500 from <c>ix_users_email</c>.</summary>
public class GoogleSignInEmailTakenTests
{
    private sealed class FakeGoogle(ProviderIdentity identity) : ProviderTokens
    {
        public override Task<ProviderIdentity?> VerifyGoogleAsync(string idToken) => Task.FromResult<ProviderIdentity?>(identity);

        public override Task<ProviderIdentity?> VerifyAppleAsync(string identityToken, CancellationToken ct = default) =>
            Task.FromResult<ProviderIdentity?>(identity with { Subject = "apple-sub" });
    }

    private static DbUpdateException UniqueViolation() =>
        new("save failed", new PostgresException("duplicate key", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation));

    private static Mock<DbSet<User>> FakeUsers(List<User> data)
    {
        var q = new TestAsyncEnumerable<User>(data);
        var set = new Mock<DbSet<User>>();
        var iq = set.As<IQueryable<User>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<User>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<User>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<User>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<User>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<User>(data.GetEnumerator()));
        set.Setup(m => m.Add(It.IsAny<User>())).Callback<User>(data.Add);
        set.Setup(m => m.Remove(It.IsAny<User>())).Callback<User>(u => data.Remove(u));
        return set;
    }

    private static AuthService Auth(List<User> users, Exception? onSave, string? tokenEmail = "taken@example.com", Action? onFirstSave = null)
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => FakeUsers(users).Object);
        db.Setup(x => x.UserRefreshTokens).Returns(new Mock<DbSet<UserRefreshToken>>().Object);
        if (onFirstSave is not null)
            // The first save fails after another request committed (a race); later saves succeed.
            db.SetupSequence(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()))
                .Returns(() => { onFirstSave(); return Task.FromException<int>(onSave!); })
                .ReturnsAsync(1);
        else
        {
            var save = db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()));
            if (onSave is null) save.ReturnsAsync(1); else save.ThrowsAsync(onSave);
        }
        return new AuthService(
            db.Object,
            Options.Create(new JwtSettings { SecretKey = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh" }),
            Options.Create(new GoogleSettings { ClientId = "test" }),
            providers: new FakeGoogle(new ProviderIdentity("google-sub", tokenEmail, "Name", null)));
    }

    [Fact]
    public async Task LoginWithGoogleAsync_NewSubjectWithAnEmailAnotherAccountHolds_IsRefusedNotAnError()
    {
        var auth = Auth([], UniqueViolation());

        var result = await auth.LoginWithGoogleAsync("id-token", CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_KnownSubjectWhoseNewEmailAnotherAccountHolds_IsRefusedNotAnError()
    {
        var users = new List<User> { new() { Id = Guid.NewGuid(), Email = "old@example.com", GoogleSubject = "google-sub", CreatedAt = DateTimeOffset.UtcNow } };
        var auth = Auth(users, UniqueViolation());

        var result = await auth.LoginWithGoogleAsync("id-token", CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_AnyOtherSaveFailure_StillThrows()
    {
        var auth = Auth([], new DbUpdateException("down"));

        await Assert.ThrowsAsync<DbUpdateException>(() => auth.LoginWithGoogleAsync("id-token", CancellationToken.None));
    }

    [Fact]
    public async Task LoginWithAppleAsync_NewSubjectWithAnEmailAnotherAccountHolds_IsRefusedNotAnError()
    {
        var auth = Auth([], UniqueViolation());

        Assert.Null(await auth.LoginWithAppleAsync("identity-token", null, null, CancellationToken.None));
    }

    [Theory]
    [InlineData("reader@privaterelay.appleid.com", "reader@privaterelay.appleid.com")]
    [InlineData(null, "apple-sub@privaterelay.appleid.com")]
    public async Task LoginWithAppleAsync_BodyEmail_IgnoredForTheTokensEmail(string? tokenEmail, string expected)
    {
        var users = new List<User>();
        var auth = Auth(users, onSave: null, tokenEmail);

        var result = await auth.LoginWithAppleAsync("identity-token", null, "someone@example.com", CancellationToken.None);

        Assert.Equal(expected, result?.user.Email);
    }

    [Fact]
    public async Task LoginWithAppleAsync_SameSubjectCreatedConcurrently_SignsIntoThatAccount()
    {
        var users = new List<User>();
        var winner = new User { Id = Guid.NewGuid(), Email = "apple-sub@privaterelay.appleid.com", AppleSubject = "apple-sub", CreatedAt = DateTimeOffset.UtcNow };
        var auth = Auth(users, UniqueViolation(), tokenEmail: null, onFirstSave: () => users.Add(winner));

        var result = await auth.LoginWithAppleAsync("identity-token", null, null, CancellationToken.None);

        Assert.Equal(winner.Id, result?.user.Id);
    }
}
