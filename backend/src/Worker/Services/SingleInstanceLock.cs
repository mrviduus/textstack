using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Worker.Services;

/// <summary>
/// ADR-022/023 say the Worker is the only consumer of its queues, but nothing enforced it; a second copy
/// (`--scale`, a deploy overlap) would race every claim. This holds a Postgres session advisory lock for the
/// life of the process: a second copy waits here, before any other hosted service starts, and takes over when
/// the first exits (the lock goes with its connection, so a crash releases it too).
/// Register FIRST. Polls <c>pg_try_advisory_lock</c> instead of blocking: the database sets statement_timeout
/// to 10 s, which would cancel a blocking <c>pg_advisory_lock</c>.
/// ponytail: the lock is lost if this connection drops (database restart) and is not re-taken; add a
/// watchdog that re-acquires, or exits, if that ever matters.
/// </summary>
public sealed class SingleInstanceLock(string connectionString, ILogger<SingleInstanceLock> logger) : IHostedService
{
    /// <summary>Arbitrary but fixed; the ssg-worker uses its own key (ssgJob.mjs).</summary>
    public const long Key = 0x54533001;

    private static readonly TimeSpan RetryEvery = TimeSpan.FromSeconds(5);
    private NpgsqlConnection? _connection;

    public async Task StartAsync(CancellationToken ct)
    {
        // Unpooled: Dispose must close the physical connection, which is what releases the lock.
        var builder = new NpgsqlConnectionStringBuilder(connectionString) { Pooling = false };
        _connection = new NpgsqlConnection(builder.ConnectionString);
        await _connection.OpenAsync(ct);

        var warned = false;
        while (!await TryLockAsync(ct))
        {
            if (!warned)
                logger.LogWarning("Another worker instance holds the single-instance lock; waiting for it to exit");
            warned = true;
            await Task.Delay(RetryEvery, ct);
        }
        logger.LogInformation("Single-instance lock acquired");
    }

    public async Task StopAsync(CancellationToken ct)
    {
        if (_connection is not null) await _connection.DisposeAsync();
    }

    private async Task<bool> TryLockAsync(CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT pg_try_advisory_lock(@key)", _connection);
        cmd.Parameters.AddWithValue("key", Key);
        return (bool)(await cmd.ExecuteScalarAsync(ct))!;
    }
}
