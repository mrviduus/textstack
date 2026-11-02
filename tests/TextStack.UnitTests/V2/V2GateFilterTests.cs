using System.Diagnostics;
using Api.Middleware;
using Api.V2;
using Application.Auth;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests.V2;

/// <summary>
/// <see cref="V2Gate"/> and <see cref="V2Readiness"/> on fakes: the outcomes a healthy stack cannot
/// produce (V2 behind, a check that never answers, an email held by another V2 account, a deleted
/// legacy account with a warm shadow cache).
/// </summary>
public class V2GateFilterTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static V2Readiness Readiness(Func<CancellationToken, Task<List<string>>> readPending, TimeSpan? checkTimeout = null) =>
        new(TimeProvider.System, NullLogger<V2Readiness>.Instance, configured: true, readPending, checkTimeout ?? V2Readiness.DefaultCheckTimeout);

    private static V2Readiness Ready() => Readiness(_ => Task.FromResult(new List<string>()));

    private readonly List<User> _legacyUsers = [];
    private readonly Mock<IUserRepository> _v2Users = new();
    private readonly ServiceProvider _services;

    public V2GateFilterTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(d => d.Users).Returns(new FakeDbSet<User>(_legacyUsers));
        _services = new ServiceCollection()
            .AddSingleton(new AuthService(db.Object,
                Options.Create(new JwtSettings { SecretKey = "unit-test-secret-key-of-at-least-32-bytes" }),
                Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" })))
            .AddSingleton(new V2ShadowUsers(_v2Users.Object, TimeProvider.System, NullLogger<V2ShadowUsers>.Instance))
            .BuildServiceProvider();
    }

    /// <summary>Runs the gate for <paramref name="userId"/>; the result, and whether the endpoint ran.</summary>
    private async Task<(object? Result, bool ReachedEndpoint)> GateAsync(Guid userId, V2Readiness? readiness = null)
    {
        var http = new DefaultHttpContext { RequestServices = _services };
        http.Items[PathGates.UserIdKey] = userId;
        var reached = false;
        var result = await new V2Gate(readiness ?? Ready()).InvokeAsync(new DefaultEndpointFilterInvocationContext(http), _ =>
        {
            reached = true;
            return ValueTask.FromResult<object?>(Results.Ok());
        });
        return (result, reached);
    }

    private static int? StatusOf(object? result) => (result as IStatusCodeHttpResult)?.StatusCode;

    [Fact]
    public async Task InvokeAsync_LegacyAccountDeletedWithAWarmShadowCache_IsUnauthorized()
    {
        var user = new User { Id = Guid.NewGuid(), Email = "reader@textstack.test" };
        _legacyUsers.Add(user);
        _v2Users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());
        Assert.True((await GateAsync(user.Id)).ReachedEndpoint);

        _legacyUsers.Remove(user); // DELETE /me/account answered 204; the access token still validates
        var (result, reached) = await GateAsync(user.Id);

        Assert.Equal((401, false), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_EmailHeldByAnotherV2Account_IsV2UnavailableAndTheEndpointNeverRuns()
    {
        var user = new User { Id = Guid.NewGuid(), Email = "Reader@textstack.test" };
        _legacyUsers.Add(user);

        var (result, reached) = await GateAsync(user.Id);

        Assert.Equal((503, false), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_V2Behind_IsV2UnavailableBeforeAnyAccountIsRead()
    {
        var (result, reached) = await GateAsync(Guid.NewGuid(), Readiness(_ => Task.FromResult(new List<string> { "0002_next" })));

        Assert.Equal((503, false), (StatusOf(result), reached));
        _v2Users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GetAsync_LedgerWithAPendingMigration_IsBehindAndNotReady()
    {
        var state = await Readiness(_ => Task.FromResult(new List<string> { "0002_next" })).GetAsync();

        Assert.Equal((V2State.Behind, false, "0002_next"), (state.Status, state.IsReady, Assert.Single(state.Pending!)));
    }

    [Fact]
    public async Task GetAsync_CheckThatNeverAnswers_GivesUpAtTheCheckTimeout()
    {
        // A blackholed host: the connect waits for the token and nothing else.
        var hung = Readiness(async ct => { await Task.Delay(Timeout.Infinite, ct); return []; }, TimeSpan.FromMilliseconds(200));

        var watch = Stopwatch.StartNew();
        var state = await hung.GetAsync().WaitAsync(TimeSpan.FromSeconds(3), Ct);

        Assert.Equal(V2State.Unreachable, state.Status);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"took {watch.Elapsed}");
    }
}
