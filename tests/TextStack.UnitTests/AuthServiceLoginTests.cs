using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Moq;

namespace TextStack.UnitTests;

public class AuthServiceLoginTests
{
    private readonly List<User> _users = [];
    private readonly AuthService _service;

    public AuthServiceLoginTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => FakeSet(_users).Object);
        db.Setup(x => x.UserRefreshTokens).Returns(() => FakeSet(new List<UserRefreshToken>()).Object);
        _service = new AuthService(
            db.Object,
            Options.Create(new JwtSettings { SecretKey = new string('k', 64) }),
            Options.Create(new GoogleSettings { ClientId = "test" }));
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        return set;
    }

    // A malformed stored hash (a bad hand edit, a truncated migration) threw from BCrypt and answered
    // 500. It is a failed login like any other: 401, not an outage of that account's sign-in page.
    [Theory]
    [InlineData("a1.4p2eGarbage")]
    [InlineData("$2a$11$tooShort")]
    [InlineData("")]
    public async Task LoginWithEmailAsync_MalformedStoredHash_ReturnsNullNotThrow(string hash)
    {
        _users.Add(new User { Id = Guid.NewGuid(), Email = "qa@test.dev", Name = "QA", PasswordHash = hash });

        var result = await _service.LoginWithEmailAsync("qa@test.dev", "whatever", CancellationToken.None);

        Assert.Null(result);
    }
}
