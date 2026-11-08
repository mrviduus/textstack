using Infrastructure.Services;

namespace TextStack.UnitTests.V2;

/// <summary>
/// /health/ready's write probe (<see cref="FileStoreRegistration.ProbeWriteAsync"/>, #1110), called directly:
/// no host, no database. The status codes are pinned in TextStack.IntegrationTests' HealthReadyLibraryTests.
/// </summary>
public sealed class HealthReadyProbeTests : IDisposable
{
    private readonly string _dir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "health-probe-" + Guid.NewGuid())).FullName;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task ProbeWriteAsync_FiftyConcurrentProbes_AllOkAndNoProbeFileLeft()
    {
        var results = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => Task.Run(() => FileStoreRegistration.ProbeWriteAsync(_dir, Ct), Ct)));

        Assert.All(results, Assert.Null);
        Assert.Empty(Directory.EnumerateFileSystemEntries(_dir));
    }

    [Fact]
    public async Task ProbeWriteAsync_RootMissing_ReturnsErrorAndLeavesNothing()
    {
        var error = await FileStoreRegistration.ProbeWriteAsync(Path.Combine(_dir, "missing"), Ct);

        Assert.Equal(nameof(DirectoryNotFoundException), error);
        Assert.Empty(Directory.EnumerateFileSystemEntries(_dir));
    }
}
