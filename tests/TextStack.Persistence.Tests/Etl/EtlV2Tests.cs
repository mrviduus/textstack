using Dapper;
using Infrastructure.Persistence.Etl;
using Npgsql;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// The <c>etl-v2</c> skeleton on a Testcontainers pair: each test gets its own legacy database (built
/// by <c>migrate.sh</c>) and its own <c>textstack_v2</c> (by <c>v2/run.sh</c>), so counts and the
/// ledger are the test's alone.
/// </summary>
[Collection("etl_reader")]
public sealed class EtlV2Tests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2)
{
    private async Task<EtlV2Options> NewPairAsync(bool dryRun = false)
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        await ExecAsync(source, "INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'a@test', NULL, now())");
        return new EtlV2Options(source, await V2.Databases.NewV2Async(name), dryRun);
    }



    [Fact]
    public async Task RunAsync_DryRun_WritesNothing()
    {
        var options = await NewPairAsync(dryRun: true);
        await ExecAsync(options.Target, "INSERT INTO users (id, email, created_at) VALUES (gen_random_uuid(), 'shadow@test', now())");
        var before = await RunAsync(options, [], Ct);
        PostgresException? targetWrite = null;
        var attempt = new EtlV2Step("write-target", async (context, ct) =>
        {
            await using var conn = await context.Target.OpenConnectionAsync(ct);
            targetWrite = await Assert.ThrowsAsync<PostgresException>(() =>
                conn.ExecuteAsync(new CommandDefinition("INSERT INTO users (id, email, created_at) VALUES (gen_random_uuid(), 'x@test', now())", cancellationToken: ct)));
        });

        var report = await RunAsync(options, [attempt], Ct);

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

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [write], Ct));

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
            RunAsync(options with { Source = alias.ConnectionString }, [], Ct));

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
        var first = RunAsync(options, [new("hold", async (_, _) => { started.SetResult(); await release.Task; })], Ct);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RunAsync(options with { DryRun = dryRun }, [], Ct).WaitAsync(TimeSpan.FromSeconds(10), Ct));
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

        await RunAsync(options, [probe], Ct);

        // What a run killed inside a step leaves behind.
        Assert.Equal(1, unfinishedSeenElsewhere);
    }

    [Fact]
    public async Task RunAsync_EarlierRunInterrupted_ClosedKeptAndRetrySucceeds()
    {
        var options = await NewPairAsync();
        var interrupted = Guid.NewGuid();
        await ExecAsync(options.Target, $"INSERT INTO migration_runs (id, started_at) VALUES ('{interrupted}', now() - interval '1 hour')");

        var report = await RunAsync(options, [], Ct);

        Assert.Equal(interrupted, Assert.Single(report.InterruptedRuns).Id);
        Assert.True(await ScalarAsync<bool>(options.Target,
            $"SELECT outcome = 'interrupted' AND finished_at >= started_at AND validation IS NULL AND validation_failures IS NULL FROM migration_runs WHERE id = '{interrupted}'"));
        Assert.Equal("succeeded", await ScalarAsync<string>(options.Target, $"SELECT outcome FROM migration_runs WHERE id = '{report.RunId}'"));
        Assert.Equal(2, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_DryRunEarlierRunInterrupted_ReportedNotClosed()
    {
        var options = await NewPairAsync(dryRun: true);
        var interrupted = Guid.NewGuid();
        await ExecAsync(options.Target, $"INSERT INTO migration_runs (id) VALUES ('{interrupted}')");

        var report = await RunAsync(options, [], Ct);

        Assert.Equal(interrupted, Assert.Single(report.InterruptedRuns).Id);
        Assert.True(await ScalarAsync<bool>(options.Target, $"SELECT finished_at IS NULL AND outcome IS NULL FROM migration_runs WHERE id = '{interrupted}'"));
    }

    [Fact]
    public async Task RunAsync_OwnRowClosedByAnotherRun_FinishThrowsOverlap()
    {
        var options = await NewPairAsync();
        // What a second run does if it ever got the lock while this one still wrote.
        var close = new EtlV2Step("closed-elsewhere", (_, _) => ExecAsync(options.Target,
            "UPDATE migration_runs SET outcome = 'interrupted', finished_at = GREATEST(clock_timestamp(), started_at) WHERE finished_at IS NULL"));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [close], Ct));

        Assert.Contains("closed as interrupted by another run; its writes overlapped", error.Message);
        Assert.Equal("interrupted", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_SourceDumpSha_WrittenToLedger()
    {
        var options = await NewPairAsync();
        var sha = new string('a', 64);

        var report = await RunAsync(options with { SourceDumpSha = sha }, [], Ct);

        Assert.Equal(sha, report.SourceDumpSha);
        Assert.Equal(sha, await ScalarAsync<string>(options.Target, $"SELECT source_dump_sha FROM migration_runs WHERE id = '{report.RunId}'"));
    }

    [Fact]
    public async Task RunAsync_Succeeded_ServerStampsAndZeroValidationFailures()
    {
        var options = await NewPairAsync();

        var report = await RunAsync(options, [], Ct);

        Assert.True(await ScalarAsync<bool>(options.Target,
            $"SELECT validation_failures = 0 AND jsonb_typeof(validation) = 'object' AND finished_at >= started_at AND started_at <= now() FROM migration_runs WHERE id = '{report.RunId}'"));
    }

    [Fact]
    public async Task RunAsync_PostgresErrorQuotingRowValue_LedgerKeepsTypeAndSqlStateOnly()
    {
        var options = await NewPairAsync();
        await ExecAsync(options.Source, "UPDATE users SET email = 'jane@example.com'");
        var cast = new EtlV2Step("cast", (context, ct) => context.Source.Connection!.ExecuteAsync(new CommandDefinition(
            "SELECT CAST(email AS int) FROM users", transaction: context.Source, cancellationToken: ct)));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [cast], Ct));

        Assert.Contains("jane@example.com", error.Message);
        var validation = await ScalarAsync<string>(options.Target, "SELECT validation::text FROM migration_runs WHERE outcome = 'failed'");
        Assert.DoesNotContain("jane", validation);
        Assert.Equal("""{"error": {"type": "PostgresException", "sqlState": "22P02"}, "checks": []}""", validation);
        Assert.Equal(1, await ScalarAsync<int>(options.Target, "SELECT validation_failures FROM migration_runs WHERE outcome = 'failed'"));
    }

    [Fact]
    public async Task RunAsync_ReRun_CountsUnchangedNewLedgerRow()
    {
        var options = await NewPairAsync();

        var first = await RunAsync(options, [], Ct);
        var second = await RunAsync(options, [], Ct);

        Assert.NotEqual(first.RunId, second.RunId);
        Assert.Empty(second.InterruptedRuns);
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

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [fail], Ct));

        Assert.Equal("boom, connected with ***", error.Message);
        var stored = await ScalarAsync<string>(options.Target, "SELECT validation::text FROM migration_runs WHERE outcome = 'failed' AND finished_at IS NOT NULL");
        Assert.Equal("""{"error": {"type": "InvalidDataException", "sqlState": null}, "checks": []}""", stored);
    }

    [Fact]
    public async Task RunAsync_Report_ShowsConnectionStringsWithoutPasswords()
    {
        var options = await NewPairAsync();

        var report = await RunAsync(options, [], Ct);

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
            RunAsync(new EtlV2Options("Host=db;Password=hunter2;Bogus Key=1", "Host=db", DryRun: true), [], Ct));

        Assert.Equal("--source is not a valid connection string", error.Message);
    }

    [Fact]
    public async Task RunAsync_SameClusterOtherDatabase_Allowed()
    {
        // Legacy and textstack_v2 side by side in one cluster (production's layout): same system id, other name.
        var name = NewName();
        var source = await NewSourceAsync(name);
        var target = await Legacy.Databases.NewV2Async(name + "_v2");

        var report = await RunAsync(new EtlV2Options(source, target, DryRun: false), [], Ct);

        Assert.NotNull(report.RunId);
        Assert.Equal(await ScalarAsync<string>(source, "SELECT system_identifier::text FROM pg_control_system()"),
            await ScalarAsync<string>(target, "SELECT system_identifier::text FROM pg_control_system()"));
    }

    [Fact]
    public async Task RunAsync_TargetIsTemplateCopy_Allowed()
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        var original = await Legacy.Databases.NewV2Async(name + "_v2");
        NpgsqlConnection.ClearAllPools(); // CREATE DATABASE ... TEMPLATE needs the template free of sessions
        await ExecAsync(source, $"CREATE DATABASE \"{name}_copy\" TEMPLATE \"{name}_v2\"");
        var copy = new NpgsqlConnectionStringBuilder(original) { Database = name + "_copy" }.ConnectionString;

        var report = await RunAsync(new EtlV2Options(source, copy, DryRun: false), [], Ct);

        Assert.NotNull(report.RunId);
    }

    [Fact]
    public async Task RunAsync_SameDatabaseHostColonPortForm_Rejected()
    {
        var options = await NewPairAsync();
        var target = new NpgsqlConnectionStringBuilder(options.Target);
        // "Host=127.0.0.1:<port>" with the Port key left at its default: another spelling of the same server.
        var alias = new NpgsqlConnectionStringBuilder(options.Target) { Host = $"127.0.0.1:{target.Port}" };
        alias.Remove("Port");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RunAsync(options with { Source = alias.ConnectionString, DryRun = true }, [], Ct));

        Assert.Contains("same database", error.Message);
    }

    [Fact]
    public async Task RunAsync_DatabaseNamesDifferOnlyInCase_Allowed()
    {
        // Postgres database names are case-sensitive: "Etl_X" and "etl_x" are two databases.
        var name = NewName();
        var source = await NewSourceAsync(name.ToUpperInvariant());
        var target = await Legacy.Databases.NewV2Async(name);

        var report = await RunAsync(new EtlV2Options(source, target, DryRun: true), [], Ct);

        Assert.Equal(0, report.SourceCounts["users"]);
    }

    [Fact]
    public async Task RunAsync_OtherSourceSameTarget_RefusedByTargetLock()
    {
        var options = await NewPairAsync();
        var otherSource = await NewSourceAsync(NewName());
        var (started, release) = (new TaskCompletionSource(), new TaskCompletionSource());
        var first = RunAsync(options, [new("hold", async (_, _) => { started.SetResult(); await release.Task; })], Ct);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RunAsync(options with { Source = otherSource }, [], Ct).WaitAsync(TimeSpan.FromSeconds(10), Ct));
        release.SetResult();
        await first;

        Assert.Contains("another etl-v2 run", error.Message);
    }

    [Fact]
    public async Task RunAsync_NonSuperuserRoles_IdentityAndDryRunWork()
    {
        // Production's roles are not superusers: pg_control_system() and the counts must work without it.
        var options = await NewPairAsync(dryRun: true);
        const string password = "p'a;s\"s w=rd";
        string Role(string cs) => new NpgsqlConnectionStringBuilder(cs) { Username = "etl_ro", Password = password }.ConnectionString;
        foreach (var cs in new[] { options.Source, options.Target })
        {
            var db = new NpgsqlConnectionStringBuilder(cs).Database;
            await ExecAsync(cs, $"""
                DO $$ BEGIN CREATE ROLE etl_ro LOGIN PASSWORD 'p''a;s"s w=rd'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                GRANT CONNECT ON DATABASE "{db}" TO etl_ro;
                GRANT SELECT ON ALL TABLES IN SCHEMA public TO etl_ro;
                """);
        }

        var report = await RunAsync(options with { Source = Role(options.Source), Target = Role(options.Target) }, [], Ct);

        Assert.Equal(1, report.SourceCounts["users"]);
        Assert.DoesNotContain("s w=rd", report.Source + report.Target);
    }

    [Fact]
    public async Task RunAsync_WrongPasswordWithSpecialCharacters_MessageDoesNotQuoteIt()
    {
        var options = await NewPairAsync(dryRun: true);
        const string password = "wr'o;n\"g=pw";
        var bad = new NpgsqlConnectionStringBuilder(options.Source) { Password = password }.ConnectionString;

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options with { Source = bad }, [], Ct));

        Assert.DoesNotContain("n\"g=pw", error.Message);
    }

    [Fact]
    public async Task RunAsync_SourceSnapshot_RepeatableReadAcrossSteps()
    {
        var options = await NewPairAsync();
        long seen = -1;
        var step = new EtlV2Step("concurrent-write", async (context, ct) =>
        {
            // A row committed on the source after the run started is outside the run's snapshot.
            await ExecAsync(options.Source, "INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'late@test', NULL, now())");
            seen = await context.Source.Connection!.ExecuteScalarAsync<long>(new CommandDefinition(
                "SELECT count(*) FROM users", transaction: context.Source, cancellationToken: ct));
        });

        var report = await RunAsync(options, [step], Ct);

        Assert.Equal(1, seen);
        Assert.Equal(1, report.SourceCounts["users"]);
    }

    [Theory]
    [InlineData("SET transaction_read_only = off")]
    [InlineData("COMMIT; INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'c@test', NULL, now())")]
    public async Task RunAsync_StepEscapesSourceSnapshot_StillReadOnly(string sql)
    {
        var options = await NewPairAsync();
        var step = new EtlV2Step("escape", (context, ct) =>
            context.Source.Connection!.ExecuteAsync(new CommandDefinition(sql, cancellationToken: ct)));

        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [step], Ct));

        Assert.Equal(1, await ScalarAsync<long>(options.Source, "SELECT count(*) FROM users"));
    }

    [Fact]
    public async Task RunAsync_DryRunStepFails_NoLedgerRow()
    {
        var options = await NewPairAsync(dryRun: true);
        var fail = new EtlV2Step("fail", (_, _) => throw new InvalidDataException("boom"));

        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [fail], Ct));

        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_DryRunTargetWriteThroughUnitOfWork_Refused()
    {
        var options = await NewPairAsync(dryRun: true);
        var write = new EtlV2Step("write-target-tx", async (context, ct) =>
        {
            await using var tx = await context.Target.BeginAsync(ct);
            await tx.Connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO users (id, email, created_at) VALUES (gen_random_uuid(), 'x@test', now())", transaction: tx.Transaction, cancellationToken: ct));
            await tx.CommitAsync(ct);
        });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [write], Ct));

        Assert.Equal(PostgresErrorCodes.ReadOnlySqlTransaction, Assert.IsType<PostgresException>(error.InnerException).SqlState);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM users"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_AfterFailedRun_NextRunGetsLock(bool dryRun)
    {
        var options = await NewPairAsync(dryRun);
        var fail = new EtlV2Step("fail", (_, _) => throw new InvalidDataException("boom"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [fail], Ct));

        var report = await RunAsync(options, [], Ct).WaitAsync(TimeSpan.FromSeconds(30), Ct);

        Assert.Equal(dryRun, report.RunId is null);
    }

    [Fact]
    public async Task RunAsync_LockRefused_HolderUnaffectedAndLockFreedAfter()
    {
        var options = await NewPairAsync();
        var (started, release) = (new TaskCompletionSource(), new TaskCompletionSource());
        var first = RunAsync(options, [new("hold", async (_, _) => { started.SetResult(); await release.Task; })], Ct);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30), Ct);
        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [], Ct));
        release.SetResult();
        await first;

        var third = await RunAsync(options, [], Ct).WaitAsync(TimeSpan.FromSeconds(30), Ct);

        Assert.NotNull(third.RunId);
    }

    [Fact]
    public async Task RunAsync_TargetWithoutMigrationRuns_FailsWithoutWritingAndFreesLock()
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        var migrated = await V2.Databases.NewV2Async(name);
        await ExecAsync(migrated, $"CREATE DATABASE \"{name}_bare\"");
        var bare = new NpgsqlConnectionStringBuilder(migrated) { Database = name + "_bare" }.ConnectionString;

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(new EtlV2Options(source, bare, false), [], Ct));

        Assert.Contains("migration_runs", error.Message);
        // Exactly etl-v2's lock on this database: a bigint key is classid = high 32 bits, objid = low 32, objsubid = 1.
        Assert.False(await ScalarAsync<bool>(bare, $"""
            SELECT EXISTS (SELECT FROM pg_locks
                WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND classid = ({EtlV2.LockKey}::bigint >> 32)::oid AND objid = ({EtlV2.LockKey}::bigint & 4294967295)::oid AND objsubid = 1)
            """));
    }

    [Fact]
    public async Task RunAsync_CancelledDuringStep_LedgerFailedAndLockFreed()
    {
        var options = await NewPairAsync();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var step = new EtlV2Step("slow", async (context, ct) =>
        {
            cts.Cancel();
            await context.Source.Connection!.ExecuteAsync(new CommandDefinition("SELECT pg_sleep(30)", transaction: context.Source, cancellationToken: ct));
        });

        var error = await Assert.ThrowsAnyAsync<Exception>(() => RunAsync(options, [step], cts.Token).WaitAsync(TimeSpan.FromSeconds(20), Ct));

        Assert.NotNull(Assert.IsType<EtlV2CanceledException>(error).RunId);
        Assert.Equal("failed", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs"));
        Assert.Equal("OperationCanceledException", await ScalarAsync<string>(options.Target, "SELECT validation -> 'error' ->> 'type' FROM migration_runs"));
        Assert.NotNull(await RunAsync(options, [], Ct).WaitAsync(TimeSpan.FromSeconds(30), Ct));
    }

    [Fact]
    public async Task RunAsync_StepReportsOrphansAndCleanups_ListedInReportAndLedgerNothingDeleted()
    {
        var options = await NewPairAsync();
        var step = new EtlV2Step("orphans", (context, _) =>
        {
            context.OrphanCandidates.Add("user_books 42: owner missing");
            context.CleanupActions.Add("DELETE FROM book_files WHERE id = 7");
            return Task.CompletedTask;
        });

        var report = await RunAsync(options, [step], Ct);

        Assert.Equal(["user_books 42: owner missing"], report.OrphanCandidates);
        Assert.Equal(["DELETE FROM book_files WHERE id = 7"], report.CleanupActions);
        Assert.Equal("user_books 42: owner missing", await ScalarAsync<string>(options.Target, $"SELECT validation -> 'orphanCandidates' ->> 0 FROM migration_runs WHERE id = '{report.RunId}'"));
        Assert.Equal("DELETE FROM book_files WHERE id = 7", await ScalarAsync<string>(options.Target, $"SELECT validation -> 'cleanupActions' ->> 0 FROM migration_runs WHERE id = '{report.RunId}'"));
        Assert.Equal(1, await ScalarAsync<long>(options.Source, "SELECT count(*) FROM users"));
    }

    [Fact]
    public async Task RunAsync_FailedRun_LedgerKeepsSourceCountsAndFinishedAt()
    {
        var options = await NewPairAsync();
        var fail = new EtlV2Step("fail", (_, _) => throw new InvalidDataException("boom"));

        await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [fail], Ct));

        Assert.True(await ScalarAsync<bool>(options.Target,
            "SELECT finished_at IS NOT NULL AND (counts -> 'source' ->> 'users')::bigint = 1 FROM migration_runs WHERE outcome = 'failed'"));
    }

    [Fact]
    public async Task RunAsync_StepQuotesTargetOnlyPassword_Scrubbed()
    {
        // The source and target passwords differ, so each one must be on the scrub list on its own.
        var options = await NewPairAsync();
        const string targetPassword = "tgt-only-s3cret";
        var db = new NpgsqlConnectionStringBuilder(options.Target).Database;
        await ExecAsync(options.Target, $"""
            DO $$ BEGIN CREATE ROLE etl_rw LOGIN PASSWORD '{targetPassword}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            GRANT CONNECT ON DATABASE "{db}" TO etl_rw;
            GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO etl_rw;
            """);
        var target = new NpgsqlConnectionStringBuilder(options.Target) { Username = "etl_rw", Password = targetPassword }.ConnectionString;
        var fail = new EtlV2Step("fail", (_, _) => throw new InvalidDataException($"boom {targetPassword}"));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options with { Target = target }, [fail], Ct));

        Assert.Equal("boom ***", error.Message);
        Assert.DoesNotContain(targetPassword, await ScalarAsync<string>(options.Target, "SELECT validation::text FROM migration_runs WHERE outcome = 'failed'"));
    }

    [Fact]
    public async Task RunAsync_NoValidationCheck_FailsClosed()
    {
        var options = await NewPairAsync();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, [], Ct));

        Assert.Contains("no validation check ran", error.Message);
        Assert.Equal("1/NoValidationChecks/[]", await ScalarAsync<string>(options.Target,
            "SELECT validation_failures || '/' || (validation -> 'error' ->> 'type') || '/' || (validation -> 'checks')::text FROM migration_runs WHERE outcome = 'failed'"));
    }

    [Fact]
    public async Task RunAsync_DryRunNoValidationCheck_ReportsZeroChecks()
    {
        // A dry run writes no gate row, so 0 checks is reported (the CLI warns), not failed: its exit code stays the audit's.
        var options = await NewPairAsync(dryRun: true);

        var report = await EtlV2.RunAsync(options, [], Ct);

        Assert.Empty(report.Checks);
        Assert.Equal(1, report.SourceCounts["users"]);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_LockConnectionKilledMidRun_FailsAtNextStepNeverSucceeds()
    {
        var options = await NewPairAsync();
        var kill = new EtlV2Step("kill-lock-session", (_, _) => ExecAsync(options.Target, $"""
            SELECT pg_terminate_backend(pid) FROM pg_locks
            WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid = ({EtlV2.LockKey}::bigint >> 32)::oid AND objid = ({EtlV2.LockKey}::bigint & 4294967295)::oid AND objsubid = 1
            """));
        var reached = false;
        var after = new EtlV2Step("after", (_, _) => { reached = true; return Task.CompletedTask; });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [kill, after], Ct));

        Assert.Contains("lock lost: another run may be writing", error.Message);
        Assert.False(reached);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs WHERE outcome = 'succeeded'"));
    }

    [Fact]
    public async Task RunAsync_CancelDuringSuccessFinish_Succeeded()
    {
        var options = await NewPairAsync();
        await SlowLedgerAsync(options.Target, "UPDATE", "NEW.outcome = 'succeeded'");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        var run = RunAsync(options, [], cts.Token);
        await WaitForActiveAsync(options.Target, "UPDATE migration_runs");
        await cts.CancelAsync();
        var report = await run;

        // The finish committed, so the run is succeeded, Ctrl+C or not.
        Assert.Equal("succeeded", await ScalarAsync<string>(options.Target, $"SELECT outcome FROM migration_runs WHERE id = '{report.RunId}'"));
    }

    [Fact]
    public async Task RunAsync_CancelDuringStartInsert_RecordedOnTheRow()
    {
        var options = await NewPairAsync();
        await SlowLedgerAsync(options.Target, "INSERT", "true");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        var run = RunAsync(options, [], cts.Token);
        await WaitForActiveAsync(options.Target, "INSERT INTO migration_runs");
        await cts.CancelAsync();
        var error = await Assert.ThrowsAsync<EtlV2CanceledException>(() => run);

        Assert.NotNull(error.RunId);
        Assert.Equal("failed/OperationCanceledException", await ScalarAsync<string>(options.Target,
            $"SELECT outcome || '/' || (validation -> 'error' ->> 'type') FROM migration_runs WHERE id = '{error.RunId}'"));
    }

    /// <summary>A trigger that holds the ledger's <paramref name="operation"/> for a second when <paramref name="when"/>: a window to cancel in.</summary>
    private static Task SlowLedgerAsync(string target, string operation, string when) => ExecAsync(target, $"""
        CREATE FUNCTION slow_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF {when} THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$;
        CREATE TRIGGER slow_ledger BEFORE {operation} ON migration_runs FOR EACH ROW EXECUTE FUNCTION slow_ledger();
        """);

    private static async Task WaitForActiveAsync(string target, string queryPrefix)
    {
        for (var waited = 0; waited < 20_000; waited += 20)
        {
            if (await ScalarAsync<bool>(target, $"SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query LIKE '{queryPrefix}%')"))
                return;
            await Task.Delay(20, Ct);
        }
        throw new TimeoutException($"no active `{queryPrefix}` within 20 s");
    }

    [Fact]
    public async Task RunAsync_CheckFindsFailures_FailedWithTheirCount()
    {
        var options = await NewPairAsync();
        var check = new EtlV2Step("count-parity", (context, _) =>
        {
            context.Checks.Add(new("users parity", 2));
            context.Checks.Add(new("books parity", 0));
            return Task.CompletedTask;
        });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, [check], Ct));

        Assert.Contains("validation found 2 failure(s)", error.Message);
        Assert.Equal("2/ValidationFailed/2", await ScalarAsync<string>(options.Target,
            "SELECT validation_failures || '/' || (validation -> 'error' ->> 'type') || '/' || jsonb_array_length(validation -> 'checks') FROM migration_runs WHERE outcome = 'failed'"));
    }

    [Fact]
    public async Task RunAsync_ChecksPass_RecordedWithZeroFailures()
    {
        var options = await NewPairAsync();

        var report = await RunAsync(options, [], Ct);

        Assert.Equal([new EtlV2Check("trivial", 0)], report.Checks);
        Assert.Equal("trivial", await ScalarAsync<string>(options.Target,
            $"SELECT validation -> 'checks' -> 0 ->> 'Name' FROM migration_runs WHERE id = '{report.RunId}' AND validation_failures = 0"));
    }

    [Fact]
    public async Task RunAsync_CancelledBeforeLedgerRow_NothingRecorded()
    {
        var options = await NewPairAsync();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var error = await Assert.ThrowsAsync<EtlV2CanceledException>(() => RunAsync(options, [], cts.Token));

        Assert.Null(error.RunId);
        Assert.Equal("cancelled; nothing recorded", error.Message);
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_StepCancelsItsOwnToken_OrdinaryFailure()
    {
        var options = await NewPairAsync();
        var step = new EtlV2Step("own-token", (_, _) => throw new OperationCanceledException());

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => RunAsync(options, [step], Ct));

        Assert.IsType<OperationCanceledException>(error.InnerException);
        Assert.Equal("failed", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_DatabaseStatementTimeout_Overridden()
    {
        // Production's database sets statement_timeout = 10 s; a test-sized one on both sides.
        var options = await NewPairAsync();
        foreach (var cs in new[] { options.Source, options.Target })
            await ExecAsync(cs, $"ALTER DATABASE \"{new NpgsqlConnectionStringBuilder(cs).Database}\" SET statement_timeout = '100ms'");
        string? targetTimeout = null;
        var slow = new EtlV2Step("slow", async (context, ct) =>
        {
            await context.Source.Connection!.ExecuteAsync(new CommandDefinition("SELECT pg_sleep(0.5)", transaction: context.Source, cancellationToken: ct));
            await using var conn = await context.Target.OpenConnectionAsync(ct);
            await conn.ExecuteAsync(new CommandDefinition("SELECT pg_sleep(0.5)", cancellationToken: ct));
            targetTimeout = await conn.ExecuteScalarAsync<string>(new CommandDefinition("SHOW statement_timeout", cancellationToken: ct));
        });

        var report = await RunAsync(options, [slow], Ct);

        Assert.NotNull(report.RunId);
        Assert.Equal("0", targetTimeout);
    }

    [Fact]
    public void ToString_Options_PasswordsRedacted()
    {
        var options = new EtlV2Options("Host=db;Username=etl_reader;Password=hunter2", "Host=db;Password=hunter3;SSL Password=hunter4", DryRun: true);
        var unparseable = options with { Source = "Password='hunter5" };

        var printed = $"{options} {unparseable}";

        Assert.DoesNotContain("hunter", printed);
        Assert.Contains("Username=etl_reader", printed);
        Assert.Contains("(not a valid connection string)", printed);
    }

    [Fact]
    public void MakeEtlV2_Recipe_NotEchoed()
    {
        var lines = File.ReadAllLines(Path.Combine(PostgresFixture.RepoRoot(), "Makefile"));
        var recipe = lines[Array.IndexOf(lines, "etl-v2:") + 1];

        Assert.StartsWith("\t@", recipe);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MakeEtlV2_ConnectionStringsInEnv_PassedByNameOnly(bool set)
    {
        var marker = Path.Combine(Path.GetTempPath(), "etl-make-" + Guid.NewGuid().ToString("N"));
        // make -n prints the command make would run: what ps would show of docker compose.
        var make = new System.Diagnostics.ProcessStartInfo("make", "-n etl-v2 ARGS=--dry-run")
        {
            WorkingDirectory = PostgresFixture.RepoRoot(),
            RedirectStandardOutput = true,
        };
        if (set)
        {
            // A $ in a password must reach docker as text, never be expanded (or run) by make.
            make.Environment["ConnectionStrings__Default"] = $"Host=db;Username=etl_reader;Password=env-s3cret$(shell touch {marker})";
            make.Environment["ConnectionStrings__V2"] = $"Host=db;Password=env-s3cret$(shell touch {marker})";
        }
        else
        {
            make.Environment.Remove("ConnectionStrings__Default");
            make.Environment.Remove("ConnectionStrings__V2");
        }
        using var process = System.Diagnostics.Process.Start(make)!;
        var command = await process.StandardOutput.ReadToEndAsync(Ct);
        await process.WaitForExitAsync(Ct);

        Assert.DoesNotContain("env-s3cret", command);
        Assert.False(File.Exists(marker), "make expanded $(shell …) in a connection string");
        // Unset: no bare -e, which would blank the container's own connection strings.
        Assert.Equal(set, command.Contains("-e ConnectionStrings__Default "));
        Assert.Equal(set, command.Contains("-e ConnectionStrings__V2 "));
        // A one-off container of the api image, not exec into the running one (a deploy would recreate it).
        Assert.StartsWith("docker compose run --rm --no-deps -T ", command);
        Assert.Contains(" api etl-v2 --dry-run", command);
    }

    [Fact]
    public void EtlSourceFiles_Scanned_NoBlanketOnConflictDoNothing()
    {
        // v2-plan §5.2: per-aggregate conflict rules; a blanket DO NOTHING hides a re-run's divergence.
        var dir = Path.Combine(PostgresFixture.RepoRoot(), "backend", "src", "Infrastructure", "Persistence", "Etl");
        var offenders = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
            .Where(f => System.Text.RegularExpressions.Regex.IsMatch(File.ReadAllText(f), @"ON\s+CONFLICT\s+DO\s+NOTHING", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            .ToList();

        Assert.Empty(offenders);
    }

    [Theory]
    [InlineData("Host=db;Password='hunter2;x\"y'")]
    [InlineData("Host=db;PWD=hunter2")]
    [InlineData("Host=db;psw=hunter2")]
    public void Redact_QuotedOrAliasedPassword_Stripped(string connectionString)
    {
        Assert.DoesNotContain("hunter2", EtlV2.Redact(connectionString));
    }


}
