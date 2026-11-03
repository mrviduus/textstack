using Application.Common.Interfaces;
using Application.Identity;
using Application.Library;
using Domain.Entities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using TextStack.UnitTests.Fakes;
using TextStack.UnitTests.V2;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// The guest reaper with V2 in the picture (#1100): a guest engaged on V2 is not reaped on legacy's
/// say-so, a reaped one's V2 account and bytes go after the legacy commit, and V2 failing or hanging
/// never deletes a guest on a guess nor reaches the reaper as an exception.
/// </summary>
public class GuestCleanupWorkerTests
{
    private readonly List<User> _legacyUsers = [];
    private readonly Mock<IUserRepository> _v2Users = new();
    private readonly Mock<IAccountMergeRepository> _v2Aggregates = new();
    private readonly Mock<ILibraryRepository> _library = new();
    private readonly Mock<ILibraryFileStore> _files = new();
    private readonly CapturingLogger<GuestCleanupWorker> _log = new();

    public GuestCleanupWorkerTests() =>
        _library.Setup(l => l.ListStorageKeysAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync([]);

    private User ExpiredGuest()
    {
        var guest = new User { Id = Guid.NewGuid(), Email = "guest@guest.local", IsGuest = true, LastActiveAt = DateTimeOffset.UtcNow.AddDays(-40) };
        _legacyUsers.Add(guest);
        return guest;
    }

    private void V2Holds(bool nothing) =>
        _v2Aggregates.Setup(u => u.HoldsNothingDurableAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync(nothing);

    private async Task SweepAsync(bool flag = true, string? v2 = "Host=v2;Database=textstack_v2", TimeSpan? budget = null)
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(d => d.Users).Returns(() => new FakeDbSet<User>(_legacyUsers));
        db.Setup(d => d.VocabularyWords).Returns(() => new FakeDbSet<VocabularyWord>([]));
        db.Setup(d => d.Highlights).Returns(() => new FakeDbSet<Highlight>([]));
        db.Setup(d => d.Bookmarks).Returns(() => new FakeDbSet<Bookmark>([]));
        db.Setup(d => d.UserLibraries).Returns(() => new FakeDbSet<UserLibrary>([]));
        db.Setup(d => d.UserBooks).Returns(() => new FakeDbSet<UserBook>([]));
        db.Setup(d => d.ReadingProgresses).Returns(() => new FakeDbSet<ReadingProgress>([]));
        await using var services = new ServiceCollection()
            .AddScoped(_ => db.Object)
            .AddSingleton(Mock.Of<IFileStorageService>())
            .AddSingleton(new V2AccountDeletion(_v2Users.Object, _v2Aggregates.Object, _library.Object, _files.Object, NullLogger<V2AccountDeletion>.Instance))
            .BuildServiceProvider();
        var config = V2Fakes.Config(flag, v2);
        var worker = new GuestCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), config, _log) { V2Budget = budget ?? TimeSpan.FromSeconds(10) };

        await worker.CleanupExpiredGuestsAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_FlagOnNothingOnV2_ReapedOnLegacyThenOnV2()
    {
        var guest = ExpiredGuest();
        V2Holds(nothing: true);

        await SweepAsync();

        Assert.Empty(_legacyUsers);
        _v2Users.Verify(u => u.DeleteAsync(guest.Id, It.IsAny<CancellationToken>()), Times.Once);
        _files.Verify(f => f.DeleteUser(guest.Id), Times.Once);
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_FlagOnGuestHoldsAV2Book_Kept()
    {
        var guest = ExpiredGuest();
        V2Holds(nothing: false);

        await SweepAsync();

        Assert.Equal(guest, Assert.Single(_legacyUsers));
        _v2Users.Verify(u => u.DeleteAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_FlagOff_ReapedWithoutAskingV2()
    {
        // Today's behaviour: V2 holdings of a reaped guest are orphans the M3 ETL sweep collects (#1094).
        ExpiredGuest();

        await SweepAsync(flag: false);

        Assert.Empty(_legacyUsers);
        _v2Users.VerifyNoOtherCalls();
        _v2Aggregates.VerifyNoOtherCalls();
        _files.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_FlagOnNoV2ConnectionString_ReapedOnLegacyWithoutAskingV2()
    {
        // Unconfigured, V2 holds nothing (the Api's readiness says "unconfigured"): reaping goes on as before.
        ExpiredGuest();

        await SweepAsync(v2: null);

        Assert.Empty(_legacyUsers);
        _v2Users.VerifyNoOtherCalls();
        _v2Aggregates.VerifyNoOtherCalls();
        Assert.Empty(_log.Errors);
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_V2CannotAnswer_NobodyReapedAndOneErrorSayingSo()
    {
        ExpiredGuest();
        ExpiredGuest();
        _v2Aggregates.Setup(u => u.HoldsNothingDurableAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        await SweepAsync();

        Assert.Equal(2, _legacyUsers.Count);
        var (_, message, exception) = Assert.Single(_log.Errors);
        Assert.IsType<TimeoutException>(exception);
        Assert.Contains("guest reaping paused for this run", message);
    }

    // Its own timeout: a budget that is not honoured must fail this test, not hang the run.
    [Fact(Timeout = 10_000)]
    public async Task CleanupExpiredGuestsAsync_V2CheckHangs_GivesUpAtItsBudget()
    {
        ExpiredGuest();
        _v2Aggregates.Setup(u => u.HoldsNothingDurableAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
            .Returns(async (Guid _, CancellationToken ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                return true;
            });

        await SweepAsync(budget: TimeSpan.FromMilliseconds(50));

        Assert.Single(_legacyUsers);
        Assert.IsAssignableFrom<OperationCanceledException>(Assert.Single(_log.Errors).Exception);
    }

    [Fact]
    public async Task CleanupExpiredGuestsAsync_V2DeleteThrows_LegacyDeleteStandsAndAnErrorNamingTheGuest()
    {
        var guest = ExpiredGuest();
        V2Holds(nothing: true);
        _v2Users.Setup(u => u.DeleteAsync(guest.Id, It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        await SweepAsync();

        Assert.Empty(_legacyUsers);
        var (_, message, exception) = Assert.Single(_log.Errors);
        Assert.IsType<TimeoutException>(exception);
        Assert.Contains(guest.Id.ToString(), message);
        // Rows first: a failed delete touches no bytes.
        _files.VerifyNoOtherCalls();
    }
}
