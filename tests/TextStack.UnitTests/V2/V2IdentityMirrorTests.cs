using System.Diagnostics;
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

/// <summary>"Legacy unaffected with V2 down", at the seam that owns it: the mirror never throws into the legacy sign-in, register or delete.</summary>
public class V2IdentityMirrorTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly IReadOnlyDictionary<Guid, Guid> None = new Dictionary<Guid, Guid>();
    private static readonly AccountMerge Merged = new(AccountMergeOutcome.Merged, None, None, None, 0, 0, 0);

    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<IAccountMergeRepository> _merges = new();
    private readonly CapturingLogger _log = new();
    private readonly User _account = new() { Id = Guid.NewGuid(), Email = "reader@textstack.test" };
    private readonly Guid _guest = Guid.NewGuid();
    private readonly V2ShadowUsers _shadows;
    private int _checks;

    public V2IdentityMirrorTests()
    {
        _shadows = new V2ShadowUsers(_users.Object, new MemoryCache(new MemoryCacheOptions()), NullLogger<V2ShadowUsers>.Instance);
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());
    }

    private V2IdentityMirror Mirror(bool flag = true, bool ready = true, TimeSpan? timeout = null)
    {
        var legacy = new Mock<IAppDbContext>();
        legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>([_account]));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = flag.ToString() }).Build();
        var readiness = V2ReadinessTests.Readiness(_ => { _checks++; return Task.FromResult(ready ? new List<string>() : ["0002_next"]); });
        return new(config, readiness, _shadows, _users.Object, _merges.Object, legacy.Object, _log) { Timeout = timeout ?? TimeSpan.FromSeconds(10) };
    }

    private void MergeReturns(AccountMerge merge) =>
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>())).ReturnsAsync(merge);

    private static PostgresException Unique() => new("duplicate key", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation);

    [Fact]
    public async Task MergeAsync_V2Throws_FailedAndLoggedAtErrorWithBothIds()
    {
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("bug"));

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal((V2MirrorStatus.Failed, nameof(InvalidOperationException), null), (result.Status, result.Reason, result.Merge));
        var (level, message) = Assert.Single(_log.Entries);
        Assert.Equal(LogLevel.Error, level);
        Assert.Contains(_guest.ToString(), message);
        Assert.Contains(_account.Id.ToString(), message);
    }

    [Fact]
    public async Task DeleteAsync_V2Throws_FailedAndLoggedAtError()
    {
        _users.Setup(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        var result = await Mirror().DeleteAsync(_account.Id);

        Assert.Equal(V2MirrorStatus.Failed, result.Status);
        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    [Theory]
    [InlineData(false, true, "flag_off")]
    [InlineData(true, false, "v2_not_ready")]
    public async Task Mirror_FlagOffOrNotReady_SkippedQuietlyWithoutTouchingV2(bool flag, bool ready, string reason)
    {
        var mirror = Mirror(flag, ready);

        var merged = await mirror.MergeAsync(_guest, _account.Id, legacyMerged: true);
        var deleted = await mirror.DeleteAsync(_account.Id);
        var promoted = await mirror.PromoteAsync(_account.Id, _account.Email, null, "hash");

        Assert.Equal((reason, reason, reason), (merged.Reason, deleted.Reason, promoted.Reason));
        Assert.Empty(_log.Entries);
        _merges.VerifyNoOtherCalls();
        _users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task MergeAsync_LegacyDidNotMerge_NoV2Call()
    {
        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: false);

        Assert.Equal((V2MirrorStatus.Skipped, "legacy_not_merged"), (result.Status, result.Reason));
        _merges.VerifyNoOtherCalls();
        _users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task MergeAsync_Ready_EnsuresTheAccountRowClearsItsGuestFlagThenMerges()
    {
        MergeReturns(Merged);

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal((V2MirrorStatus.Mirrored, Merged), (result.Status, result.Merge));
        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _account.Id && !a.IsGuest), It.IsAny<CancellationToken>()));
        _users.Verify(u => u.ClearGuestFlagAsync(_account.Id, It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task MergeAsync_Refused_SkippedNotMirroredAndLoggedAtError()
    {
        MergeReturns(AccountMerge.Refused);

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal((V2MirrorStatus.Skipped, "merge_refused"), (result.Status, result.Reason));
        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    [Fact]
    public async Task MergeAsync_AccountEmailHeldByAnotherV2Account_SkippedAndLoggedAtError()
    {
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync((UserAccount?)null);

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal((V2MirrorStatus.Skipped, "account_email_taken"), (result.Status, result.Reason));
        Assert.Contains(_guest.ToString(), Assert.Single(_log.Entries, e => e.Level == LogLevel.Error).Message);
        _merges.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task MergeAsync_UniqueViolationOnce_RetriedAndMerged()
    {
        _merges.SetupSequence(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()))
            .ThrowsAsync(Unique()).ReturnsAsync(Merged);

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal(V2MirrorStatus.Mirrored, result.Status);
        Assert.Empty(_log.Entries);
    }

    [Fact]
    public async Task MergeAsync_UniqueViolationTwice_Failed()
    {
        _merges.SetupSequence(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()))
            .ThrowsAsync(Unique()).ThrowsAsync(Unique());

        var result = await Mirror().MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal((V2MirrorStatus.Failed, nameof(PostgresException)), (result.Status, result.Reason));
        _merges.Verify(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public async Task MergeAsync_ConnectionFails_ReadinessCheckedAgainNextTime()
    {
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>())).ThrowsAsync(new NpgsqlException("connection refused"));
        var mirror = Mirror();

        await mirror.MergeAsync(_guest, _account.Id, legacyMerged: true);
        await mirror.DeleteAsync(_account.Id);

        Assert.Equal(2, _checks);
    }

    [Fact]
    public async Task MergeAsync_V2HoldsALock_FailedAtTheTimeoutNotAtTheRequests()
    {
        // A merge waiting on a lock until its token gives up, as Npgsql does.
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()))
            .Returns<Guid, Guid, NpgsqlTransaction?, CancellationToken>(async (_, _, _, ct) => { await Task.Delay(Timeout.Infinite, ct); return Merged; });
        var clock = Stopwatch.StartNew();

        var result = await Mirror(timeout: TimeSpan.FromMilliseconds(200)).MergeAsync(_guest, _account.Id, legacyMerged: true);

        Assert.Equal(V2MirrorStatus.Failed, result.Status);
        Assert.InRange(clock.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(5));
        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    [Fact]
    public async Task DeleteAsync_Mirrored_ForgetsTheShadowSoTheNextRequestMakesItAgain()
    {
        await _shadows.EnsureAsync(LegacyOf(_account), _account.Id, Ct);

        Assert.Equal(V2MirrorStatus.Mirrored, (await Mirror().DeleteAsync(_account.Id)).Status);
        await _shadows.EnsureAsync(LegacyOf(_account), _account.Id, Ct);

        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    private static IAppDbContext LegacyOf(User user)
    {
        var legacy = new Mock<IAppDbContext>();
        legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>([user]));
        return legacy.Object;
    }

    [Theory]
    [InlineData(AccountUpdateOutcome.Updated, V2MirrorStatus.Mirrored, 0)]
    [InlineData(AccountUpdateOutcome.NotFound, V2MirrorStatus.Skipped, 0)]
    [InlineData(AccountUpdateOutcome.EmailTaken, V2MirrorStatus.Skipped, 1)]
    public async Task PromoteAsync_GuestRegisteredInPlace_V2RowPromoted(AccountUpdateOutcome outcome, V2MirrorStatus status, int errors)
    {
        _users.Setup(u => u.PromoteGuestAsync(_account.Id, _account.Email, "Reader", "hash", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new AccountUpdate(outcome, null));

        var result = await Mirror().PromoteAsync(_account.Id, _account.Email, "Reader", "hash");

        Assert.Equal((status, errors), (result.Status, _log.Entries.Count(e => e.Level == LogLevel.Error)));
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
