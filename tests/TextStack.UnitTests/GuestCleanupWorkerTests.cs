using Application.Identity;
using Application.Library;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using TextStack.UnitTests.Fakes;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// The reaper's V2 follow-up (#1100): an expired guest's V2 account and bytes go after its legacy
/// delete, and V2 failing never reaches the reaper.
/// </summary>
public class GuestCleanupWorkerTests
{
    private const string V2 = "Host=v2;Database=textstack_v2";

    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<ILibraryRepository> _library = new();
    private readonly Mock<ILibraryFileStore> _files = new();
    private readonly CapturingLogger<GuestCleanupWorker> _log = new();
    private readonly Guid _guest = Guid.NewGuid();

    public GuestCleanupWorkerTests() =>
        _library.Setup(l => l.ListStorageKeysAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync([]);

    private async Task DeleteOnV2Async(bool flag = true, string? v2 = V2, TimeSpan? budget = null)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Features:V2Api"] = flag.ToString(),
            ["ConnectionStrings:V2"] = v2,
        }).Build();
        await using var services = new ServiceCollection()
            .AddSingleton(new V2AccountDeletion(_users.Object, _library.Object, _files.Object, NullLogger<V2AccountDeletion>.Instance))
            .BuildServiceProvider();
        var worker = new GuestCleanupWorker(null!, config, _log) { V2Budget = budget ?? TimeSpan.FromSeconds(10) };
        await worker.DeleteOnV2Async(services, _guest).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task DeleteOnV2Async_FlagOn_DeletesTheGuestsV2RowsAndDirectories()
    {
        await DeleteOnV2Async();

        _users.Verify(u => u.DeleteAsync(_guest, It.IsAny<CancellationToken>()), Times.Once);
        _files.Verify(f => f.DeleteUser(_guest), Times.Once);
    }

    [Fact]
    public async Task DeleteOnV2Async_FlagOff_TouchesNothingOnV2()
    {
        await DeleteOnV2Async(flag: false);

        _users.VerifyNoOtherCalls();
        _files.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task DeleteOnV2Async_NoV2ConnectionString_TouchesNothingOnV2()
    {
        await DeleteOnV2Async(v2: null);

        _users.VerifyNoOtherCalls();
        Assert.Empty(_log.Entries);
    }

    [Fact]
    public async Task DeleteOnV2Async_V2Throws_AnErrorLogNamingTheGuestNotAnException()
    {
        _users.Setup(u => u.DeleteAsync(_guest, It.IsAny<CancellationToken>())).ThrowsAsync(new TimeoutException());

        await DeleteOnV2Async();

        var (level, message, exception) = Assert.Single(_log.Entries);
        Assert.Equal(LogLevel.Error, level);
        Assert.IsType<TimeoutException>(exception);
        Assert.Contains(_guest.ToString(), message);
    }

    [Fact]
    public async Task DeleteOnV2Async_V2Hangs_GivesUpAtItsBudget()
    {
        _users.Setup(u => u.DeleteAsync(_guest, It.IsAny<CancellationToken>()))
            .Returns(async (Guid _, CancellationToken ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                return true;
            });

        await DeleteOnV2Async(budget: TimeSpan.FromMilliseconds(50));

        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }
}
