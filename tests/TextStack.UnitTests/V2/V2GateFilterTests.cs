using Api.V2;
using Application.Identity;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Npgsql;
using NSubstitute;

namespace TextStack.UnitTests.V2;

/// <summary>
/// <see cref="V2Gate"/> on fakes: the outcomes a healthy stack cannot produce (V2 behind, a deleted account
/// whose token still validates, a V2 error mid-request).
/// </summary>
public class V2GateFilterTests
{
    private readonly IUserRepository _users = Substitute.For<IUserRepository>();
    private int _checks;
    private readonly V2Readiness _ready;

    public V2GateFilterTests() =>
        _ready = V2ReadinessTests.Readiness(_ => { _checks++; return Task.FromResult(new List<string>()); });

    private Guid Account()
    {
        var id = Guid.NewGuid();
        _users.GetAsync(id, Arg.Any<CancellationToken>()).Returns(new UserAccount { Id = id });
        return id;
    }

    /// <summary>Runs the gate for <paramref name="userId"/>'s session; the result, and whether the endpoint ran.</summary>
    private async Task<(object? Result, bool ReachedEndpoint)> GateAsync(Guid userId, V2Readiness? readiness = null, Exception? endpointThrows = null)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers.Authorization = "Bearer " + TestTokens.Token(userId);
        var reached = false;
        var result = await new V2Gate(readiness ?? _ready, TestTokens.ReadOnlyAuth(), _users)
            .InvokeAsync(new DefaultEndpointFilterInvocationContext(http), _ =>
            {
                reached = true;
                return endpointThrows is null ? ValueTask.FromResult<object?>(Results.Ok()) : throw endpointThrows;
            });
        return (result, reached);
    }

    private static int? StatusOf(object? result) => (result as IStatusCodeHttpResult)?.StatusCode;

    [Fact]
    public async Task InvokeAsync_AccountExists_ReachesTheEndpoint()
    {
        var (result, reached) = await GateAsync(Account());

        Assert.Equal((200, true), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_AccountDeletedButTokenValid_IsUnauthorized()
    {
        var (result, reached) = await GateAsync(Guid.NewGuid());

        Assert.Equal((401, false), (StatusOf(result), reached));
    }

    [Fact]
    public async Task InvokeAsync_V2Behind_IsV2UnavailableBeforeAnyAccountIsRead()
    {
        var (result, reached) = await GateAsync(Guid.NewGuid(), V2ReadinessTests.Readiness(_ => Task.FromResult(new List<string> { "0002_next" })));

        Assert.Equal((503, false), (StatusOf(result), reached));
        Assert.Empty(_users.ReceivedCalls());
    }

    [Fact]
    public async Task InvokeAsync_V2ErrorFromTheEndpoint_EmptiesTheReadinessCacheAndRethrows()
    {
        await Assert.ThrowsAsync<PostgresException>(() =>
            GateAsync(Account(), endpointThrows: new PostgresException("connection lost", "FATAL", "FATAL", "57P01")));
        await _ready.GetAsync();

        Assert.Equal(2, _checks);
    }

    [Fact]
    public async Task InvokeAsync_UsersForeignKeyViolation_IsUnauthorized()
    {
        // The user's V2 row vanished mid-request (a guest merged into an account): not a 500.
        var (result, _) = await GateAsync(Account(), endpointThrows: new PostgresException(
            "violates foreign key", "ERROR", "ERROR", PostgresErrorCodes.ForeignKeyViolation, constraintName: "fk_books_users_user_id"));

        Assert.Equal(401, StatusOf(result));
    }
}
