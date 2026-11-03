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
        return set;
    }

    private static AuthService Auth(List<User> users, Exception? onSave)
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => FakeUsers(users).Object);
        var save = db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()));
        if (onSave is null) save.ReturnsAsync(1); else save.ThrowsAsync(onSave);
        return new AuthService(
            db.Object,
            Options.Create(new JwtSettings { SecretKey = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh" }),
            Options.Create(new GoogleSettings { ClientId = "test" }),
            providers: new FakeGoogle(new ProviderIdentity("google-sub", "taken@example.com", "Name", null)));
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
}
