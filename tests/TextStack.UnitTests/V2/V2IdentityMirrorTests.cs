using Api.V2;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Npgsql;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests.V2;

/// <summary>"Legacy unaffected with V2 down", at the seam that owns it: the mirror never throws into the legacy sign-in or delete.</summary>
public class V2IdentityMirrorTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<IAccountMergeRepository> _merges = new();
    private readonly CapturingLogger _log = new();
    private readonly User _account = new() { Id = Guid.NewGuid(), Email = "reader@textstack.test" };
    private readonly Guid _guest = Guid.NewGuid();

    private V2IdentityMirror Mirror(bool flag = true, bool ready = true)
    {
        var legacy = new Mock<IAppDbContext>();
        legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>([_account]));
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = flag.ToString() }).Build();
        var readiness = V2ReadinessTests.Readiness(_ => Task.FromResult(ready ? new List<string>() : ["0002_next"]));
        var shadows = new V2ShadowUsers(_users.Object, new MemoryCache(new MemoryCacheOptions()), NullLogger<V2ShadowUsers>.Instance);
        return new(config, readiness, shadows, _users.Object, _merges.Object, legacy.Object, _log);
    }

    [Fact]
    public async Task MergeAsync_V2Throws_FailedAndLoggedAtErrorWithBothIds()
    {
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>())).ThrowsAsync(new NpgsqlException("down"));

        var result = await Mirror().MergeAsync(_guest, _account.Id, Ct);

        Assert.Equal((V2MirrorStatus.Failed, nameof(NpgsqlException), null), (result.Status, result.Reason, result.Merge));
        var (level, message) = Assert.Single(_log.Entries);
        Assert.Equal(LogLevel.Error, level);
        Assert.Contains(_guest.ToString(), message);
        Assert.Contains(_account.Id.ToString(), message);
    }

    [Fact]
    public async Task DeleteAsync_V2Throws_FailedAndLoggedAtError()
    {
        _users.Setup(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        var result = await Mirror().DeleteAsync(_account.Id, Ct);

        Assert.Equal(V2MirrorStatus.Failed, result.Status);
        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    [Theory]
    [InlineData(false, true, "flag_off")]
    [InlineData(true, false, "v2_not_ready")]
    public async Task MergeAndDelete_FlagOffOrNotReady_SkippedWithoutTouchingV2(bool flag, bool ready, string reason)
    {
        var mirror = Mirror(flag, ready);

        var merged = await mirror.MergeAsync(_guest, _account.Id, Ct);
        var deleted = await mirror.DeleteAsync(_account.Id, Ct);

        Assert.Equal((V2MirrorStatus.Skipped, reason, V2MirrorStatus.Skipped, reason), (merged.Status, merged.Reason, deleted.Status, deleted.Reason));

        _merges.VerifyNoOtherCalls();
        _users.Verify(u => u.DeleteAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task MergeAsync_Ready_EnsuresTheAccountRowThenMerges()
    {
        var merged = new AccountMerge(AccountMergeOutcome.Merged, new Dictionary<Guid, Guid>(), new Dictionary<Guid, Guid>(), new Dictionary<Guid, Guid>(), 0, 0, 0);
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>())).ReturnsAsync(merged);

        var result = await Mirror().MergeAsync(_guest, _account.Id, Ct);

        Assert.Equal((V2MirrorStatus.Mirrored, merged), (result.Status, result.Merge));
        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _account.Id && !a.IsGuest), It.IsAny<CancellationToken>()));
        _users.Verify(u => u.ClearGuestFlagAsync(_account.Id, It.IsAny<CancellationToken>()));
    }

    private sealed class CapturingLogger : ILogger<V2IdentityMirror>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Entries.Add((logLevel, formatter(state, exception)));
    }
}
