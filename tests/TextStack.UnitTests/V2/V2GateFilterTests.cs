using Api.V2;
using Application.Auth;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using Npgsql;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests.V2;

/// <summary>
/// <see cref="V2Gate"/> on fakes: the outcomes a healthy stack cannot produce (V2 behind, an email held
/// by another V2 account, a deleted legacy account with a warm shadow cache, a V2 error mid-request).
/// </summary>
public class V2GateFilterTests
{
    private readonly List<User> _legacyUsers = [];
    private readonly Mock<IAppDbContext> _legacy = new();
    private readonly Mock<IUserRepository> _v2Users = new();
    private readonly V2ShadowUsers _shadows;
    private readonly AuthService _auth;
    private int _checks;
    private readonly V2Readiness _ready;

    public V2GateFilterTests()
    {
        _legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>(_legacyUsers));
        _shadows = new V2ShadowUsers(_v2Users.Object, new MemoryCache(new MemoryCacheOptions()), NullLogger<V2ShadowUsers>.Instance);
        _auth = new AuthService(_legacy.Object, Options.Create(new JwtSettings { SecretKey = TestTokens.Secret, Issuer = TestTokens.Issuer }),
            Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" }));
        _ready = V2ReadinessTests.Readiness(_ => { _checks++; return Task.FromResult(new List<string>()); });
    }

    private User LegacyUser()
    {
        var user = new User { Id = Guid.NewGuid(), Email = $"{Guid.NewGuid():N}@textstack.test" };
        _legacyUsers.Add(user);
        return user;
    }

    private void V2RowsAreCreated() =>
        _v2Users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());

    /// <summary>Runs the gate for <paramref name="userId"/>'s session; the result, and whether the endpoint ran.</summary>
    private async Task<(object? Result, bool ReachedEndpoint)> GateAsync(Guid userId, V2Readiness? readiness = null, Exception? endpointThrows = null)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers.Authorization = "Bearer " + TestTokens.Token(userId);
        var reached = false;
        var result = await new V2Gate(readiness ?? _ready, _shadows, _legacy.Object, _auth).InvokeAsync(new DefaultEndpointFilterInvocationContext(http), _ =>
        {
            reached = true;
            return endpointThrows is null ? ValueTask.FromResult<object?>(Results.Ok()) : throw endpointThrows;
        });
        return (result, reached);
    }

    private static int? StatusOf(object? result) => (result as IStatusCodeHttpResult)?.StatusCode;

    [Fact]
    public async Task InvokeAsync_LegacyAccountDeletedWithAWarmShadowCache_IsUnauthorized()
    {
        var user = LegacyUser();
        V2RowsAreCreated();
        Assert.True((await GateAsync(user.Id)).ReachedEndpoint);

        _legacyUsers.Remove(user); // DELETE /me/account answered 204; the access token still validates
        var (result, reached) = await GateAsync(user.Id);

        Assert.Equal((401, false), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_EmailHeldByAnotherV2Account_IsV2UnavailableAndTheEndpointNeverRuns()
    {
        var (result, reached) = await GateAsync(LegacyUser().Id);

        Assert.Equal((503, false), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_V2Behind_IsV2UnavailableBeforeAnyAccountIsRead()
    {
        var (result, reached) = await GateAsync(Guid.NewGuid(), V2ReadinessTests.Readiness(_ => Task.FromResult(new List<string> { "0002_next" })));

        Assert.Equal((503, false), (StatusOf(result), reached));
        _v2Users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task InvokeAsync_V2ErrorFromTheEndpoint_EmptiesTheReadinessCacheAndRethrows()
    {
        var user = LegacyUser();
        V2RowsAreCreated();

        await Assert.ThrowsAsync<PostgresException>(() =>
            GateAsync(user.Id, endpointThrows: new PostgresException("connection lost", "FATAL", "FATAL", "57P01")));
        await _ready.GetAsync();

        Assert.Equal(2, _checks);
    }

    [Fact]
    public async Task InvokeAsync_UsersForeignKeyViolation_EnsuresTheShadowRowAgainNextTime()
    {
        var user = LegacyUser();
        V2RowsAreCreated();
        await GateAsync(user.Id);

        await Assert.ThrowsAsync<PostgresException>(() => GateAsync(user.Id, endpointThrows: new PostgresException(
            "violates foreign key", "ERROR", "ERROR", PostgresErrorCodes.ForeignKeyViolation, constraintName: "fk_books_users_user_id")));
        await GateAsync(user.Id);

        _v2Users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Exactly(2));
    }
}
