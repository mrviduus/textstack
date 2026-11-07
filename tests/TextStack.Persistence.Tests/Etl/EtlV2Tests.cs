using Dapper;
using Infrastructure.Persistence.Etl;
using Npgsql;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// The <c>etl-v2</c> skeleton on a Testcontainers pair: each test gets its own legacy database (built
/// by <c>migrate.sh</c>) and its own <c>textstack_v2</c> (by <c>v2/run.sh</c>), so counts and the
/// ledger are the test's alone.
/// </summary>
public sealed class EtlV2Tests(PostgresFixture legacy, V2PostgresFixture v2)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<EtlV2Options> NewPairAsync(bool dryRun = false)
    {
        var name = "etl_" + Guid.NewGuid().ToString("N");
        var source = await legacy.NewDatabaseAsync(name);
        await ExecAsync(source, "INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'a@test', NULL, now())");
        return new EtlV2Options(source, await v2.NewDatabaseAsync(name), dryRun);
    }

    [Fact]
    public async Task RunAsync_DryRun_WritesNothing()
    {
        var options = await NewPairAsync(dryRun: true);
        await ExecAsync(options.Target, "INSERT INTO users (id, email, created_at) VALUES (gen_random_uuid(), 'shadow@test', now())");
        var before = await EtlV2.RunAsync(options, [], Ct);
        PostgresException? targetWrite = null;
        var attempt = new EtlV2Step("write-target", async (context, ct) =>
        {
            await using var conn = await context.Target.OpenConnectionAsync(ct);
            targetWrite = await Assert.ThrowsAsync<PostgresException>(() =>
                conn.ExecuteAsync(new CommandDefinition("INSERT INTO users (id, email, created_at) VALUES (gen_random_uuid(), 'x@test', now())", cancellationToken: ct)));
        });

        var report = await EtlV2.RunAsync(options, [attempt], Ct);

        Assert.Null(report.RunId);
        Assert.True(report.DryRun);
        Assert.Equal(PostgresErrorCodes.ReadOnlySqlTransaction, targetWrite!.SqlState);
        Assert.Equal(1, report.SourceCounts["users"]);
        Assert.Equal(1, report.TargetCounts["users"]);
        Assert.Equal(before.TargetCounts, report.TargetCounts);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
        Assert.Empty(report.OrphanCandidates);
        Assert.Empty(report.CleanupActions);
    }

    [Fact]
    public async Task RunAsync_StepWritesSource_ReadOnlyRefusesAndRunFails()
    {
        var options = await NewPairAsync();
        var write = new EtlV2Step("write-source", (context, ct) => context.Source.Connection!.ExecuteAsync(new CommandDefinition(
            "INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'b@test', NULL, now())",
            transaction: context.Source, cancellationToken: ct)));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, [write], Ct));

        Assert.Equal(PostgresErrorCodes.ReadOnlySqlTransaction, Assert.IsType<PostgresException>(error.InnerException).SqlState);
        Assert.Equal(1, await ScalarAsync<long>(options.Source, "SELECT count(*) FROM users"));
        Assert.Equal("failed", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs WHERE finished_at IS NOT NULL"));
    }

    [Fact]
    public async Task RunAsync_SameDatabaseByAnotherName_Rejected()
    {
        var options = await NewPairAsync();
        // Same server and database, reached by another host name: only the server-side identity tells.
        var alias = new NpgsqlConnectionStringBuilder(options.Target) { ApplicationName = "alias" };
        alias.Host = alias.Host == "localhost" ? "127.0.0.1" : "localhost";

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            EtlV2.RunAsync(options with { Source = alias.ConnectionString }, [], Ct));

        Assert.Contains("same database", error.Message);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_AnotherRunInProgress_RefusedFast(bool dryRun)
    {
        var options = await NewPairAsync();
        var (started, release) = (new TaskCompletionSource(), new TaskCompletionSource());
        var first = EtlV2.RunAsync(options, [new("hold", async (_, _) => { started.SetResult(); await release.Task; })], Ct);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            EtlV2.RunAsync(options with { DryRun = dryRun }, [], Ct).WaitAsync(TimeSpan.FromSeconds(10), Ct));
        release.SetResult();
        var report = await first;

        Assert.Contains("another etl-v2 run", error.Message);
        Assert.Equal(report.RunId, await ScalarAsync<Guid>(options.Target, "SELECT id FROM migration_runs WHERE outcome = 'succeeded'"));
        Assert.Equal(1, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_StepRunning_LedgerRowCommittedUnfinished()
    {
        var options = await NewPairAsync();
        long unfinishedSeenElsewhere = -1;
        var probe = new EtlV2Step("probe", async (_, _) =>
            unfinishedSeenElsewhere = await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs WHERE finished_at IS NULL AND outcome IS NULL"));

        await EtlV2.RunAsync(options, [probe], Ct);

        // What a run killed inside a step leaves behind.
        Assert.Equal(1, unfinishedSeenElsewhere);
    }

    [Fact]
    public async Task RunAsync_EarlierRunInterrupted_ReportedKeptAndRetrySucceeds()
    {
        var options = await NewPairAsync();
        var interrupted = Guid.NewGuid();
        await ExecAsync(options.Target, $"INSERT INTO migration_runs (id, started_at) VALUES ('{interrupted}', now() - interval '1 hour')");

        var report = await EtlV2.RunAsync(options, [], Ct);

        Assert.Equal(interrupted, Assert.Single(report.UnfinishedRuns).Id);
        Assert.True(await ScalarAsync<bool>(options.Target, $"SELECT finished_at IS NULL AND outcome IS NULL FROM migration_runs WHERE id = '{interrupted}'"));
        Assert.Equal("succeeded", await ScalarAsync<string>(options.Target, $"SELECT outcome FROM migration_runs WHERE id = '{report.RunId}'"));
    }

    [Fact]
    public async Task RunAsync_ReRun_CountsUnchangedNewLedgerRow()
    {
        var options = await NewPairAsync();

        var first = await EtlV2.RunAsync(options, [], Ct);
        var second = await EtlV2.RunAsync(options, [], Ct);

        Assert.NotEqual(first.RunId, second.RunId);
        Assert.Empty(second.UnfinishedRuns);
        Assert.Equal(first.SourceCounts, second.SourceCounts);
        Assert.Equal(first.TargetCounts, second.TargetCounts);
        Assert.Equal(2, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs WHERE outcome = 'succeeded' AND finished_at >= started_at"));
        Assert.Equal(1, await ScalarAsync<long>(options.Target, $"SELECT (counts -> 'source' ->> 'users')::bigint FROM migration_runs WHERE id = '{second.RunId}'"));
        Assert.Equal("[]", await ScalarAsync<string>(options.Target, $"SELECT validation ->> 'orphanCandidates' FROM migration_runs WHERE id = '{second.RunId}'"));
    }

    [Fact]
    public async Task RunAsync_StepFailsQuotingPassword_LedgerFailedAndNoSecretAnywhere()
    {
        var options = await NewPairAsync();
        var password = new NpgsqlConnectionStringBuilder(options.Target).Password!;
        var fail = new EtlV2Step("fail", (_, _) => throw new InvalidDataException($"boom, connected with {password}"));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, [fail], Ct));

        Assert.Equal("boom, connected with ***", error.Message);
        var stored = await ScalarAsync<string>(options.Target, "SELECT validation ->> 'error' FROM migration_runs WHERE outcome = 'failed' AND finished_at IS NOT NULL");
        Assert.Equal("InvalidDataException: boom, connected with ***", stored);
    }

    [Fact]
    public async Task RunAsync_Report_ShowsConnectionStringsWithoutPasswords()
    {
        var options = await NewPairAsync();

        var report = await EtlV2.RunAsync(options, [], Ct);

        Assert.DoesNotContain("password", report.Source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password", report.Target, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(new NpgsqlConnectionStringBuilder(options.Target).Database, new NpgsqlConnectionStringBuilder(report.Target).Database);
    }

    [Fact]
    public void Redact_PasswordAndSslPassword_Stripped()
    {
        var redacted = EtlV2.Redact("Host=db;Database=textstack;Username=app;Password=hunter2;SSL Password=hunter3");

        Assert.DoesNotContain("hunter", redacted);
        Assert.Contains("Database=textstack", redacted);
    }

    [Fact]
    public async Task RunAsync_UnparseableConnectionString_MessageDoesNotQuoteIt()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            EtlV2.RunAsync(new EtlV2Options("Host=db;Password=hunter2;Bogus Key=1", "Host=db", DryRun: true), [], Ct));

        Assert.Equal("--source is not a valid connection string", error.Message);
    }

    private static async Task ExecAsync(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.ExecuteAsync(new CommandDefinition(sql, cancellationToken: Ct));
    }

    private static async Task<T> ScalarAsync<T>(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        return (await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, cancellationToken: Ct)))!;
    }
}
