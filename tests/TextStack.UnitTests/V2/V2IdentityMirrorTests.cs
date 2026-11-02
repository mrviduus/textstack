using System.Diagnostics;
using Api.V2;
using Application.Common.Interfaces;
using Application.Identity;
using Application.Library;
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

/// <summary>
/// "Legacy unaffected with V2 down", at the seam that owns it: the mirror never throws into the legacy
/// sign-in, register or delete; what it leaves behind is visible as an Error log.
/// </summary>
public class V2IdentityMirrorTests
{
    private static readonly Dictionary<Guid, Guid> None = [];
    private static readonly AccountMerge Merged = new(AccountMergeOutcome.Merged, None, None, None, 0, 0, 0);

    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<IAccountMergeRepository> _merges = new();
    private readonly Mock<ILibraryFileStore> _files = new();
    private readonly CapturingLogger<V2IdentityMirror> _log = new();
    private readonly User _account = new() { Id = Guid.NewGuid(), Email = "reader@textstack.test" };
    private readonly Guid _guest = Guid.NewGuid();
    private int _checks;

    public V2IdentityMirrorTests() =>
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());

    private V2IdentityMirror Mirror(bool flag = true, bool ready = true, TimeSpan? timeout = null)
    {
        var legacy = new Mock<IAppDbContext>();
        legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>([_account]));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = flag.ToString() }).Build();
        var readiness = V2ReadinessTests.Readiness(_ => { _checks++; return Task.FromResult(ready ? new List<string>() : ["0002_next"]); });
        var shadows = new V2ShadowUsers(_users.Object, new MemoryCache(new MemoryCacheOptions()), NullLogger<V2ShadowUsers>.Instance);
        return new(config, readiness, shadows, _users.Object, _merges.Object, legacy.Object, _files.Object, _log) { Timeout = timeout ?? TimeSpan.FromSeconds(10) };
    }

    private Moq.Language.Flow.ISetup<IAccountMergeRepository, Task<AccountMerge>> Merge() =>
        _merges.Setup(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()));

    private static PostgresException Unique() => new("duplicate key", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation);

    private (LogLevel Level, string Message, Exception? Exception) SingleError() => Assert.Single(_log.Entries, e => e.Level == LogLevel.Error);

    [Fact]
    public async Task MergeAsync_V2Throws_NullAndAnErrorLogNamingBothIds()
    {
        Merge().ThrowsAsync(new InvalidOperationException("bug"));

        Assert.Null(await Mirror().MergeAsync(_guest, _account.Id));

        var (_, message, exception) = Assert.Single(_log.Entries);
        Assert.IsType<InvalidOperationException>(exception);
        Assert.Contains(_guest.ToString(), message);
        Assert.Contains(_account.Id.ToString(), message);
    }

    [Fact]
    public async Task DeleteAsync_RowsDeleted_DeletesTheAccountsBytesToo()
    {
        await Mirror().DeleteAsync(_account.Id);

        _files.Verify(f => f.DeleteUser(_account.Id), Times.Once);
    }

    [Fact]
    public async Task DeleteAsync_V2Throws_AnErrorLogNotAnException()
    {
        _users.Setup(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        await Mirror().DeleteAsync(_account.Id);

        Assert.IsType<TimeoutException>(SingleError().Exception);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task Mirror_FlagOffOrNotReady_QuietWithoutTouchingV2(bool flag, bool ready)
    {
        var mirror = Mirror(flag, ready);

        Assert.Null(await mirror.MergeAsync(_guest, _account.Id));
        await mirror.DeleteAsync(_account.Id);
        await mirror.PromoteAsync(_account.Id, _account.Email, null, "hash");

        Assert.Empty(_log.Entries);
        _merges.VerifyNoOtherCalls();
        _users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task MergeAsync_Merged_EnsuresTheAccountRowThenMergesAndLogsTheCounts()
    {
        var books = new Dictionary<Guid, Guid> { [Guid.NewGuid()] = Guid.NewGuid() };
        Merge().ReturnsAsync(Merged with { Books = books, DroppedDuplicates = 2, HashAnomalies = 1, UnscheduledReviewQuestions = 3 });

        var map = await Mirror().MergeAsync(_guest, _account.Id);

        Assert.Same(books, map!.Books);
        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _account.Id && !a.IsGuest), It.IsAny<CancellationToken>()));
        var (level, message, _) = Assert.Single(_log.Entries);
        Assert.Equal(LogLevel.Information, level);
        Assert.Contains("1 books, 0 files, 0 words remapped; 2 guest copies dropped, 1 of them with another payload; 3 review questions unscheduled", message);
    }

    [Fact]
    public async Task MergeAsync_MergedWithNoIdChanged_NoMap()
    {
        Merge().ReturnsAsync(Merged);

        Assert.Null(await Mirror().MergeAsync(_guest, _account.Id));
    }

    [Fact]
    public async Task MergeAsync_NoGuest_NoMapAndQuiet()
    {
        Merge().ReturnsAsync(AccountMerge.NoGuest);

        Assert.Null(await Mirror().MergeAsync(_guest, _account.Id));
        Assert.Empty(_log.Entries);
    }

    [Fact]
    public async Task MergeAsync_Refused_NoMapAndAnErrorLog()
    {
        Merge().ReturnsAsync(AccountMerge.Refused);

        Assert.Null(await Mirror().MergeAsync(_guest, _account.Id));
        Assert.Contains("merge_refused", SingleError().Message);
    }

    [Fact]
    public async Task MergeAsync_AccountEmailHeldByAnotherV2Account_NoMergeAndAnErrorLog()
    {
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync((UserAccount?)null);

        Assert.Null(await Mirror().MergeAsync(_guest, _account.Id));

        Assert.Contains("account_email_taken", SingleError().Message);
        _merges.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task MergeAsync_UniqueViolationOnce_RetriedAndMerged()
    {
        _merges.SetupSequence(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()))
            .ThrowsAsync(Unique()).ReturnsAsync(Merged);

        await Mirror().MergeAsync(_guest, _account.Id);

        Assert.Equal(LogLevel.Information, Assert.Single(_log.Entries).Level);
    }

    [Fact]
    public async Task MergeAsync_DeadlockTwice_RetriedOnceThenAnErrorLog()
    {
        var deadlock = new PostgresException("deadlock", "ERROR", "ERROR", PostgresErrorCodes.DeadlockDetected);
        _merges.SetupSequence(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()))
            .ThrowsAsync(deadlock).ThrowsAsync(deadlock);

        await Mirror().MergeAsync(_guest, _account.Id);

        Assert.Same(deadlock, SingleError().Exception);
        _merges.Verify(m => m.MergeAsync(_guest, _account.Id, null, It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public async Task DeleteAsync_UniqueViolation_NotRetried()
    {
        _users.Setup(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>())).ThrowsAsync(Unique());

        await Mirror().DeleteAsync(_account.Id);

        _users.Verify(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Theory]
    [InlineData(true, 2)]
    [InlineData(false, 1)]
    public async Task Mirror_ConnectionFailsOrUniqueViolation_ReadinessCheckedAgainOnlyAfterTheConnection(bool connection, int checks)
    {
        _users.Setup(u => u.DeleteAsync(_account.Id, It.IsAny<CancellationToken>()))
            .ThrowsAsync(connection ? new NpgsqlException("connection refused") : Unique());
        var mirror = Mirror();

        await mirror.DeleteAsync(_account.Id);
        await mirror.DeleteAsync(_account.Id);

        Assert.Equal(checks, _checks);
    }

    [Fact]
    public async Task MergeAsync_V2HoldsALock_GivesUpAtTheTimeoutWithAnErrorLog()
    {
        // A merge waiting on a lock until its token gives up, as Npgsql does.
        Merge().Returns<Guid, Guid, NpgsqlTransaction?, CancellationToken>(async (_, _, _, ct) => { await Task.Delay(Timeout.Infinite, ct); return Merged; });
        var clock = Stopwatch.StartNew();

        Assert.Null(await Mirror(timeout: TimeSpan.FromMilliseconds(200)).MergeAsync(_guest, _account.Id));

        Assert.InRange(clock.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(5));
        Assert.IsAssignableFrom<OperationCanceledException>(SingleError().Exception);
    }

    [Theory]
    [InlineData(AccountUpdateOutcome.Updated, 0)]
    [InlineData(AccountUpdateOutcome.NotFound, 0)]
    [InlineData(AccountUpdateOutcome.EmailTaken, 1)]
    public async Task PromoteAsync_GuestRegisteredInPlace_V2RowPromotedAndAnEmailClashLogged(AccountUpdateOutcome outcome, int errors)
    {
        _users.Setup(u => u.PromoteGuestAsync(_account.Id, _account.Email, "Reader", "hash", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new AccountUpdate(outcome, null));

        await Mirror().PromoteAsync(_account.Id, _account.Email, "Reader", "hash");

        Assert.Equal(errors, _log.Entries.Count(e => e.Level == LogLevel.Error));
        _users.Verify(u => u.PromoteGuestAsync(_account.Id, _account.Email, "Reader", "hash", It.IsAny<CancellationToken>()));
    }
}
