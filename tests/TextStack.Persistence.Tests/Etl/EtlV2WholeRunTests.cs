using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Infrastructure.Persistence.Etl;
using Npgsql;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// M3.4 (#1029): every step over <see cref="ProductionShapes"/>, the run-safety matrix of catalog plan §6.1 (T1
/// interrupted, T2 retry after a failed check, T3 concurrent, T4 idempotent), and <c>database/v2/scripts/validate-etl.sql</c>
/// run by psql after a real run: green on what the run wrote, red on V2 corrupted afterwards.
/// </summary>
public sealed class EtlV2WholeRunTests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2)
{
    /// <summary>Flip when ADR-032's pending migration (0005) lets V2 take fb2: the fixture's fb2 upload then migrates and validates.</summary>
    private const bool V2TakesFb2 = false;

    private const string Fb2Check = "book_files: format V2 does not take (fb2/other, pending ADR-032's migration)";

    private const string Script = "/database/v2/scripts/validate-etl.sql";

    private readonly string _files = Path.Combine(Path.GetTempPath(), "etl-v2-whole-run", Guid.NewGuid().ToString("N"));

    // xunit.v3 calls only DisposeAsync on a class that has both: the temp tree goes here, then the base drops the databases.
    public override async ValueTask DisposeAsync()
    {
        if (Directory.Exists(_files))
            Directory.Delete(_files, recursive: true);
        await base.DisposeAsync();
    }

    /// <summary>
    /// A scratch pair seeded with <see cref="ProductionShapes"/>, its bytes on disk. <paramref name="sameContainer"/>: legacy and V2
    /// in the V2 container, so psql there reaches both (validate-etl.sql); else the two fixture containers.
    /// </summary>
    private async Task<EtlV2Options> NewPairAsync(bool sameContainer = false, bool withFb2 = false, string? v2Extra = null)
    {
        var name = NewName();
        var source = sameContainer ? (await V2.Databases.NewLegacyAsync(name)).Reader : await NewSourceAsync(name);
        await ExecAsync(source, ProductionShapes.LegacySql(withFb2));
        var target = await V2.Databases.NewV2Async(name + "_v2");
        await ExecAsync(target, ProductionShapes.V2Sql + v2Extra);
        var root = Path.Combine(_files, name);
        ProductionShapes.WriteFiles(Path.Combine(root, "storage"), withFb2);
        return new EtlV2Options(source, target, DryRun: false, StorageRoot: Path.Combine(root, "storage"), LibraryRoot: Path.Combine(root, "library"));
    }

    /// <summary>Every table etl-v2 writes, each row as jsonb, sorted: two V2 databases hold the same rows iff equal.</summary>
    private Task<string> DumpAsync(EtlV2Options options, string[]? tables = null) => ScalarAsync<string>(options.Target,
        string.Join(" UNION ALL ", (tables ?? Targets).Select(t => $"SELECT '{t}' AS t, to_jsonb(x)::text AS r FROM {t} x")) is var rows
            ? $"SELECT COALESCE(string_agg(t || ' ' || r, E'\\n' ORDER BY t, r), '') FROM ({rows}) d" : "");

    private static readonly string[] Targets = [.. EtlV2.Steps.SelectMany(s => s.Targets).Distinct().Order(StringComparer.Ordinal)];

    private static readonly string[] EarlyTargets = ["users", "books", "book_files", "reading_state", "annotations", "book_chapters", "ingestion_jobs"];

    /// <summary>The library's files, relative path → sha256: what a run copied.</summary>
    private static Dictionary<string, string> Tree(EtlV2Options options) => !Directory.Exists(options.LibraryRoot)
        ? []
        : Directory.EnumerateFiles(options.LibraryRoot!, "*", SearchOption.AllDirectories).ToDictionary(
            f => Path.GetRelativePath(options.LibraryRoot!, f), f => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(f))));

    private static readonly Lock CleanGate = new();
    private static Task<(string Dump, Dictionary<string, string> Tree)>? _clean;

    /// <summary>
    /// A clean run's end state: what every scenario below must converge to. Deterministic (fixed ids and times), so one run
    /// serves the class: computed by the first test that asks, kept in memory (its databases and files go with that test).
    /// </summary>
    private Task<(string Dump, Dictionary<string, string> Tree)> CleanAsync()
    {
        lock (CleanGate)
            return _clean ??= RunCleanAsync();

        async Task<(string, Dictionary<string, string>)> RunCleanAsync()
        {
            var clean = await NewPairAsync();
            await EtlV2.RunAsync(clean, ct: Ct);
            return (await DumpAsync(clean), Tree(clean));
        }
    }

    private Task<string> LedgerAsync(EtlV2Options options) => ScalarAsync<string>(options.Target,
        "SELECT COALESCE(string_agg(COALESCE(outcome, 'unfinished'), ',' ORDER BY started_at), '') FROM migration_runs");

    // ---------------------------------------------------------------- the fixture itself

    [Fact]
    public async Task RunAsync_ProductionShapes_SucceedsWithEveryCategoryReported()
    {
        var options = await NewPairAsync();

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Equal(new EtlV2Writes(ProductionShapes.Uploads, 0, 0), report.Writes["books"]);
        Assert.Equal(new EtlV2Writes(ProductionShapes.Users, 1, 0), report.Writes["users"]); // 29 users + the admin with no user; user 1's shadow row filled
        Assert.Equal(ProductionShapes.Uploads - 1, report.Writes["book_files"].Inserted); // all but the one with no bytes
        // Pairs: Clean Code ×8 (library ×6, a card, a cluster), Kobzar ×2 (library + highlight is one, a pending word), Forest Song ×3
        // (highlight, insight, lookup), Design Patterns ×2 (progress, shelf). The dangling shelf entry is none.
        Assert.Equal(new EtlV2Writes(15, 0, 0), report.Writes["books (catalog)"]);
        Assert.Contains($"user_books {ProductionShapes.Book(ProductionShapes.TakenDown)}: taken down; carried hidden (removed_at, file content_removed_at) without bytes, cover or chapters", report.OrphanCandidates);
        Assert.Contains($"user_book_files {ProductionShapes.FileOf(ProductionShapes.NoBytes)}: no bytes on disk; book {ProductionShapes.Book(ProductionShapes.NoBytes)} migrates without a file (ADR-031 item 2)", report.OrphanCandidates);
        Assert.Equal(2, report.CleanupActions.Count(a => a.Contains(": legacy status Failed, carried with its bytes")));
        Assert.Contains(report.CleanupActions, a => a.StartsWith($"users {ProductionShapes.V2OnlyGuest}: V2 guest with no legacy row"));
        Assert.Contains(report.OrphanCandidates, o => o.EndsWith(": session-only catalog pair; carried with no book"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("catalog_pairs ") && o.Contains("is gone"));
        Assert.Equal("succeeded", await LedgerAsync(options));
        // A legacy double percent carries at its shortest round-trip digits, not Postgres's 15-digit ::numeric.
        Assert.Equal("0.3333333333333333", await ScalarAsync<string>(options.Target, "SELECT book_fraction::text FROM reading_state WHERE book_id = @id",
            new { id = ProductionShapes.Book(4) }));
        // "Word1" + NBSP / "en" + U+202F merged into word1's card (.NET's Trim), and its NBSP sentence made no example.
        Assert.Equal(1, await ScalarAsync<long>(options.Target, $"SELECT count(*) FROM vocabulary_words WHERE user_id = '{ProductionShapes.User(1)}'"));
        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM vocabulary_examples WHERE sentence = chr(160)"));
    }

    [Fact]
    public async Task RunAsync_ProductionShapesWithFb2_FailsUntilV2TakesFb2()
    {
        // ADR-032's fb2 migration (0005) has not landed: the fb2 upload fails the run by name. Flip V2TakesFb2 when it does.
        var options = await NewPairAsync(sameContainer: V2TakesFb2, withFb2: true);

        if (!V2TakesFb2)
        {
            var error = await FailsAsync(options);
            Assert.Equal([ProductionShapes.FileOf(ProductionShapes.Fb2Book).ToString()], Failed(error, Fb2Check));
            Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM books"));
            return;
        }
#pragma warning disable CS0162 // unreachable until V2TakesFb2 flips
        await EtlV2.RunAsync(options, ct: Ct);
        Assert.Equal(0, (await ValidateAsync(options)).ExitCode);
#pragma warning restore CS0162
    }

    // ---------------------------------------------------------------- T1: interrupted

    private static readonly string KillLockSql =
        $"SELECT pg_terminate_backend(pid, 5000) FROM pg_locks WHERE {EtlV2.LockMatch} AND database = (SELECT oid FROM pg_database WHERE datname = current_database())";

    /// <summary>
    /// A dead process writes no finish: the ledger refuses the run's own (a run that only lost its lock reopens a
    /// connection and records <c>failed</c>; a killed one records nothing). Dropped before the re-run.
    /// </summary>
    private Task NoFinishAsync(EtlV2Options options) => ExecAsync(options.Target, """
        CREATE FUNCTION etl_test_no_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the process is gone'; END $$;
        CREATE TRIGGER etl_test_no_finish BEFORE UPDATE ON migration_runs FOR EACH ROW EXECUTE FUNCTION etl_test_no_finish();
        """);

    /// <summary>A step standing for the process killed between two steps: its lock connection dies.</summary>
    private EtlV2Step KillProcess(EtlV2Options options) => new("kill-process", (_, _) => ExecAsync(options.Target, KillLockSql));

    /// <summary>A trigger that kills the lock connection and aborts the step's write transaction from inside it: a crash mid-step.</summary>
    private Task CrashOnWriteAsync(EtlV2Options options, string table) => ExecAsync(options.Target, $"""
        CREATE FUNCTION etl_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM {KillLockSql["SELECT ".Length..]};
            RAISE EXCEPTION 'simulated crash mid-step';
        END $$;
        CREATE TRIGGER etl_test_crash AFTER INSERT ON {table} FOR EACH STATEMENT EXECUTE FUNCTION etl_test_crash();
        """);

    /// <summary>Fault points: between two steps, or inside a step's write (the table whose insert crashes), and the tables that must still be empty.</summary>
    public static TheoryData<string, string, string[]> FaultPoints => new()
    {
        { "between", "after uploads", ["vocabulary_words", "book_insight", "reading_sessions"] },
        // COPY of book_chapters is the uploads transaction's last write: books, files, state, annotations, jobs roll back with it.
        { "mid-step", "book_chapters", ["books", "book_files", "reading_state", "annotations", "book_chapters", "ingestion_jobs"] },
        { "mid-step", "vocabulary_reviews", ["vocabulary_words", "vocabulary_examples", "vocabulary_reviews"] },
        { "mid-step", "reading_sessions", ["reading_sessions"] },
    };

    [Theory]
    [MemberData(nameof(FaultPoints))]
    public async Task RunAsync_T1KilledThenReRun_LedgerInterruptedAndEndStateIsACleanRuns(string kind, string at, string[] empty)
    {
        var (cleanDump, cleanTree) = await CleanAsync();
        var options = await NewPairAsync();
        EtlV2Step[] steps = kind == "between"
            ? [EtlV2Users.Step, EtlV2Uploads.Step, KillProcess(options), .. EtlV2.Steps.Skip(2)]
            : [.. EtlV2.Steps];
        if (kind == "mid-step")
            await CrashOnWriteAsync(options, at);
        await NoFinishAsync(options);

        var killed = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, steps, Ct));

        // The row the dead run left: unfinished, as a killed process leaves it. No half step is visible.
        Assert.Equal("unfinished", await LedgerAsync(options));
        foreach (var table in empty)
            Assert.Equal(0, await ScalarAsync<long>(options.Target, $"SELECT count(*) FROM {table}"));
        Assert.True(await ScalarAsync<long>(options.Target, "SELECT count(*) FROM users") > 2, "the users step committed before the fault");
        await ExecAsync(options.Target, $"""
            DROP TRIGGER IF EXISTS etl_test_crash ON {(kind == "mid-step" ? at : "users")}; DROP FUNCTION IF EXISTS etl_test_crash();
            DROP TRIGGER etl_test_no_finish ON migration_runs; DROP FUNCTION etl_test_no_finish();
            """);

        var rerun = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(killed.RunId, Assert.Single(rerun.InterruptedRuns).Id);
        Assert.Equal("interrupted,succeeded", await LedgerAsync(options));
        Assert.Equal(cleanDump, await DumpAsync(options));
        // Bytes a dead run copied before its rows (mid-uploads) are the ones the re-run names: no orphan, no second copy.
        Assert.Equal(cleanTree, Tree(options));
    }

    // ---------------------------------------------------------------- T2: retry after a failed check

    /// <summary>A legacy defect, its fix, the check it fails, and whether the run wrote rows before the check (uploads and earlier).</summary>
    public static TheoryData<string, string, string, bool> Defects => new()
    {
        // Vocabulary fails late: users, uploads and catalog pairs are written first, and must be left as they are.
        {
            $"UPDATE vocabulary_reviews SET review_mode = ' ' WHERE id = '72000000-0000-4000-8000-000000000522'",
            $"UPDATE vocabulary_reviews SET review_mode = 'flashcard' WHERE id = '72000000-0000-4000-8000-000000000522'",
            "vocabulary_reviews: blank review_mode", true
        },
        // The quote gate stops the uploads write: only users are written.
        {
            $"UPDATE highlights SET selected_text = 'melange' WHERE id = '{Guid.Parse("d0000000-0000-4000-8000-000000000001")}'",
            $"UPDATE highlights SET selected_text = E'spice\\tmust' WHERE id = '{Guid.Parse("d0000000-0000-4000-8000-000000000001")}'",
            "annotations: selected_text not in its chapter's plain_text", false
        },
    };

    [Theory]
    [MemberData(nameof(Defects))]
    public async Task RunAsync_T2FailedCheckThenFixed_ReRunConvergesAndLeavesDoneRowsUntouched(string defect, string fix, string check, bool uploadsWritten)
    {
        var (cleanDump, cleanTree) = await CleanAsync();
        var options = await NewPairAsync();
        await ExecAsync(options.Source, defect);

        var error = await FailsAsync(options);

        Assert.Single(Failed(error, check)!);
        Assert.Equal("failed", await LedgerAsync(options));
        Assert.Equal(1, await ScalarAsync<int>(options.Target, "SELECT validation_failures FROM migration_runs"));
        Assert.Equal(uploadsWritten, await ScalarAsync<long>(options.Target, "SELECT count(*) FROM books") > 0);
        var doneBefore = await DumpAsync(options, EarlyTargets);
        await ExecAsync(options.Source, fix);

        var retry = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(retry.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Empty(retry.InterruptedRuns);
        Assert.Equal("failed,succeeded", await LedgerAsync(options));
        if (uploadsWritten)
        {
            // Done rows untouched: nothing inserted or updated for them, every column as the failed run left it.
            Assert.All(EarlyTargets.Append("books (catalog)"), t => Assert.Equal(0, retry.Writes[t].Inserted + retry.Writes[t].Updated));
            Assert.Equal(doneBefore, await DumpAsync(options, EarlyTargets));
        }
        Assert.Equal(cleanDump, await DumpAsync(options));
        Assert.Equal(cleanTree, Tree(options));
    }

    // ---------------------------------------------------------------- T3: concurrent

    [Fact]
    public async Task RunAsync_T3SecondRunWhileOneHoldsTheLock_RefusedCleanlyAndWritesNothing()
    {
        var (cleanDump, cleanTree) = await CleanAsync();
        var options = await NewPairAsync();
        var (inside, release) = (new TaskCompletionSource(), new TaskCompletionSource());
        var gate = new EtlV2Step("gate", async (_, _) => { inside.SetResult(); await release.Task; });
        var first = EtlV2.RunAsync(options, [EtlV2Users.Step, EtlV2Uploads.Step, gate, .. EtlV2.Steps.Skip(2)], Ct);
        // A fault in the holder before the gate surfaces now, not as a 60 s timeout.
        if (await Task.WhenAny(first, inside.Task) == first)
            await first;
        await inside.Task.WaitAsync(TimeSpan.FromSeconds(60), Ct);
        var midway = await DumpAsync(options);

        var loser = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct).WaitAsync(TimeSpan.FromSeconds(30), Ct));

        Assert.Contains("another etl-v2 run holds the target's advisory lock", loser.Message);
        Assert.Null(loser.RunId);
        Assert.Empty(loser.Checks);
        // Refused before its ledger row and before any step: V2 is exactly as the holder left it.
        Assert.Equal("unfinished", await LedgerAsync(options));
        Assert.Equal(midway, await DumpAsync(options));
        release.SetResult();
        await first;
        Assert.Equal("succeeded", await LedgerAsync(options));
        Assert.Equal(cleanDump, await DumpAsync(options));
        Assert.Equal(cleanTree, Tree(options));
    }

    [Fact]
    public async Task RunAsync_T3TwoRunsAtOnce_OneWinsTheOtherIsRefusedAndTheStateIsClean()
    {
        var (cleanDump, cleanTree) = await CleanAsync();
        var options = await NewPairAsync();

        var runs = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Outcome(EtlV2.RunAsync(options, ct: Ct))));

        // Whatever the interleaving: every run either succeeded or was refused by the lock; none failed half-way.
        Assert.All(runs, r => Assert.True(r is "succeeded" or "refused", r));
        Assert.Contains("succeeded", runs);
        Assert.DoesNotContain("failed", await LedgerAsync(options));
        Assert.DoesNotContain("unfinished", await LedgerAsync(options));
        Assert.Equal(cleanDump, await DumpAsync(options));
        Assert.Equal(cleanTree, Tree(options));

        static async Task<string> Outcome(Task<EtlV2Report> run)
        {
            try
            {
                await run;
                return "succeeded";
            }
            catch (EtlV2Exception e) when (e.Message.Contains("another etl-v2 run holds"))
            {
                return "refused";
            }
            catch (EtlV2Exception e)
            {
                return "failed: " + e.Message;
            }
        }
    }

    // ---------------------------------------------------------------- T4: idempotent

    [Fact]
    public async Task RunAsync_T4RunKTimes_RunsTwoToKInsertNothingAndReportTheSame()
    {
        var options = await NewPairAsync();
        var first = await EtlV2.RunAsync(options, ct: Ct);
        var dump = await DumpAsync(options);
        var tree = Tree(options);
        var written = Directory.EnumerateFiles(options.LibraryRoot!, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.GetLastWriteTimeUtc);

        var second = await EtlV2.RunAsync(options, ct: Ct);
        var third = await EtlV2.RunAsync(options, ct: Ct);

        foreach (var run in new[] { second, third })
        {
            Assert.All(run.Writes, w => Assert.True(w.Value.Inserted + w.Value.Updated == 0, $"{w.Key}: {w.Value}"));
            Assert.Equal(first.Checks, run.Checks, (a, b) => a.Name == b.Name && a.Failures == b.Failures);
            Assert.Equal(first.OrphanCandidates, run.OrphanCandidates);
            Assert.Equal(first.CleanupActions, run.CleanupActions);
            Assert.Equal(first.SourceCounts, run.SourceCounts);
            Assert.Equal(first.TargetCounts, run.TargetCounts);
        }
        // Runs 2..k: byte-identical reports (but the run id), and ledger rows.
        Assert.Equal(Json(second), Json(third));
        Assert.Equal(1, await ScalarAsync<long>(options.Target,
            "SELECT count(DISTINCT counts::text || validation::text) FROM migration_runs WHERE id IN (@a, @b)", new { a = second.RunId, b = third.RunId }));
        Assert.Equal("succeeded,succeeded,succeeded", await LedgerAsync(options));
        Assert.Equal(dump, await DumpAsync(options));
        // 0 file writes: same files, same bytes, not rewritten.
        Assert.Equal(tree, Tree(options));
        Assert.All(written, f => Assert.Equal(f.Value, File.GetLastWriteTimeUtc(f.Key)));
        Assert.Equal(0, second.Writes["library_files"].Inserted);

        static string Json(EtlV2Report r) => JsonSerializer.Serialize(r with { RunId = null });
    }

    // ---------------------------------------------------------------- validate-etl.sql

    /// <summary>validate-etl.sql by psql in the V2 container: legacy as etl_reader (as at the cutover), V2 as its owner. Exit code and output.</summary>
    private Task<(long ExitCode, string Stdout, string Stderr)> ValidateAsync(EtlV2Options options, string? runId = null)
    {
        var (source, target) = (new NpgsqlConnectionStringBuilder(options.Source), new NpgsqlConnectionStringBuilder(options.Target));
        // argv, no shell: the password travels in the environment, nothing is spliced into a command line.
        string[] argv = ["env", $"PGPASSWORD={source.Password}", "psql", "-X", "-A", "-t", "-F", "|",
            "-d", $"host=localhost dbname={source.Database} user={source.Username}", "-v", $"v2=dbname={target.Database} user=postgres", "-f", Script];
        return V2.Databases.RunAsync(runId is null ? argv : [.. argv[..^2], "-v", $"run_id={runId}", .. argv[^2..]]);
    }

    /// <summary>The script's rows: check → (status, details).</summary>
    private static Dictionary<string, (string Status, string Details)> Rows(string stdout) => stdout.Split('\n')
        .Select(l => l.Split('|', 3)).Where(p => p.Length == 3).ToDictionary(p => p[0], p => (p[1], p[2]));

    [Fact]
    public async Task ValidateEtl_AfterARealRun_EveryCheckPassesAndReportsTheReportOnlyRows()
    {
        var options = await NewPairAsync(sameContainer: true);
        await EtlV2.RunAsync(options, ct: Ct);

        var (exit, stdout, stderr) = await ValidateAsync(options);

        Assert.True(exit == 0, stdout + stderr);
        Assert.Contains("validate-etl: all checks passed", stdout);
        var rows = Rows(stdout);
        Assert.DoesNotContain(rows, r => r.Value.Status == "FAIL");
        // Every table the run wrote has its comparison row, named as the run's Writes.
        string[] sets = ["users", "books", "books (catalog)", "book_files", "reading_state", "annotations", "annotations (catalog)", "book_chapters",
            "ingestion_jobs", "vocabulary_words", "vocabulary_examples", "vocabulary_reviews", "book_insight", "review_question", "reading_sessions"];
        Assert.All(sets, s => Assert.Equal("ok", rows[$"{s}: legacy vs V2 (count, owner, content)"].Status));
        Assert.Equal(("ok", $"legacy {ProductionShapes.Uploads}, v2 {ProductionShapes.Uploads}"), rows["books: legacy vs V2 (count, owner, content)"]);
        Assert.Equal(("ok", $"legacy {ProductionShapes.Uploads} (1 without bytes), v2 {ProductionShapes.Uploads - 1}"), rows["book_files: legacy vs V2 (count, owner, content)"]);
        Assert.StartsWith("legacy 31, v2 32 (1 v2-only, report)", rows["users: legacy vs V2 (count, owner, content)"].Details);
        // The report-only categories: listed, and the ledger names the same rows.
        Assert.Equal(("report", "legacy 1, ledger 1"), rows["report: takedowns (carried hidden, no bytes, no chapters)"]);
        Assert.Equal(("report", "legacy 2, ledger 2"), rows["report: non-ready uploads (Processing/Failed, carried)"]);
        Assert.Equal(("report", "legacy 2, ledger 2"), rows["report: deleted-upload highlight trail (not carried)"]);
        Assert.Equal(("report", "legacy 1, ledger 1"), rows["report: catalog pairs whose edition is gone (not carried)"]);
        Assert.Equal(("report", "legacy 1, ledger 1"), rows["report: session-only catalog pairs (carried with no book)"]);
        Assert.Equal("ok", rows["uuid_v5: SQL derivation = EtlV2Ids (self-test vectors)"].Status);
        Assert.Equal("ok", rows["ledger: writes = rows mapped, per target"].Status);
    }

    [Fact]
    public async Task ValidateEtl_V2OnlyRowsBeforeTheRun_ToleratedAsReport()
    {
        // Owner 2026-11-08: a V2-only user and its rows are cleanup lines, never a failure; the script agrees.
        var (stray, book) = (Guid.Parse("eeeeeeee-0000-4000-8000-000000000001"), Guid.Parse("eeeeeeee-0000-4000-8000-0000000000b1"));
        var options = await NewPairAsync(sameContainer: true, v2Extra: $$"""
            INSERT INTO users (id, email, created_at) VALUES ('{{stray}}', 'stray@test', '2026-11-01Z');
            INSERT INTO books (id, user_id, title, origin) VALUES ('{{book}}', '{{stray}}', 'Stray', '{"kind":"upload"}');
            INSERT INTO reading_sessions (id, user_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES ('{{book}}', '{{stray}}', '{{book}}', now(), now(), 30, 0, 0, 0, now());
            """);
        await EtlV2.RunAsync(options, ct: Ct);

        var (exit, stdout, stderr) = await ValidateAsync(options);

        Assert.True(exit == 0, stdout + stderr);
        var row = Rows(stdout)["report: V2 rows with no legacy row (cleanup lines, never deleted)"];
        Assert.Equal("report", row.Status);
        Assert.StartsWith("4 row(s) found", row.Details);
    }

    /// <summary>A change to V2 (or legacy, or the ledger) after a real run, and a check validate-etl.sql must fail on it.</summary>
    public static TheoryData<string, string, string> Corruptions => new()
    {
        { "v2", $"UPDATE books SET title = 'Edited' WHERE id = '{ProductionShapes.Book(1)}'", "books: legacy vs V2 (count, owner, content)" },
        { "v2", $"UPDATE books SET user_id = '{ProductionShapes.User(2)}' WHERE id = '{ProductionShapes.Book(13)}'",
            "books: legacy vs V2 (count, owner, content)" },
        { "v2", $$"""UPDATE books SET origin = '{"kind":"catalog","editionSlug":"elsewhere"}' WHERE id = '{{EtlV2Ids.CatalogBook(ProductionShapes.User(1), Guid.Parse(ProductionShapes.CleanCode))}}'""",
            "books (catalog): legacy vs V2 (count, owner, content)" },
        { "v2", $"DELETE FROM annotations WHERE id = '{Guid.Parse("d0000000-0000-4000-8000-000000002001")}'", "annotations (catalog): legacy vs V2 (count, owner, content)" },
        { "v2", $"UPDATE book_files SET sha256 = repeat('0', 64) WHERE id = '{ProductionShapes.FileOf(3)}'", "book_files: legacy vs V2 (count, owner, content)" },
        { "v2", $"UPDATE reading_state SET book_fraction = 0.99 WHERE book_id = '{ProductionShapes.Book(3)}'", "reading_state: legacy vs V2 (count, owner, content)" },
        { "v2", $"UPDATE book_chapters SET plain_text = plain_text || '!' WHERE id = '{Guid.Parse("c0000000-0000-4000-8000-000000000032")}'", "book_chapters: legacy vs V2 (count, owner, content)" },
        { "v2", $"UPDATE annotations SET selected_text = 'melange' WHERE id = '{Guid.Parse("d0000000-0000-4000-8000-000000000001")}'", "annotations: selected_text in its chapter's plain_text" },
        { "v2", "UPDATE vocabulary_words SET stage = stage + 1 WHERE id = '70000000-0000-4000-8000-000000000053'", "vocabulary_words: legacy vs V2 (count, owner, content)" },
        { "v2", "UPDATE vocabulary_examples SET sentence = 'other' WHERE sentence = 'I run daily.' AND user_id = 'a0000000-0000-4000-8000-000000000005'",
            "vocabulary_examples: legacy vs V2 (count, owner, content)" },
        { "v2", "DELETE FROM vocabulary_reviews WHERE id = '72000000-0000-4000-8000-000000000531'",
            "vocabulary: review count per survivor (legacy reviews of a merged group vs its V2 reviews)" },
        { "v2", "UPDATE book_insight SET review_json = '{\"a\":\"y\"}' WHERE id = '15000000-0000-4000-8000-000000000004'", "book_insight: legacy vs V2 (count, owner, content)" },
        { "v2", "UPDATE review_question SET prompt_hash = 'recomputed000000' WHERE id = '16000000-0000-4000-8000-000000000004'", "review_question: legacy vs V2 (count, owner, content)" },
        { "v2", "UPDATE reading_sessions SET duration_seconds = duration_seconds + 1 WHERE id = '5e000000-0000-4000-8000-000000000002'", "reading_sessions: seconds per user" },
        { "v2", $"UPDATE users SET role = 'reader' WHERE id = '{ProductionShapes.User(3)}'", "users: legacy admins are admin in V2" },
        { "v2", $"INSERT INTO book_chapters (id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, created_at) SELECT gen_random_uuid(), user_id, book_id, id, 'leak', 99, 't', 'h', 'p', now() FROM book_files WHERE book_id = '{ProductionShapes.Book(ProductionShapes.TakenDown)}'",
            "takedowns: no chapters in V2" },
        { "v2", $"UPDATE book_files SET user_id = '{ProductionShapes.User(2)}' WHERE id = '{ProductionShapes.FileOf(13)}'", "ownership: every row's owner is its parent's owner" },
        { "v2", "INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (gen_random_uuid(), 'eeeeeeee-0000-4000-8000-000000000002', 'en', 'x', 'x')",
            "unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users" },
        { "v2", "UPDATE migration_runs SET counts = jsonb_set(counts, '{source,users}', '999')", "ledger: source counts = legacy now" },
        { "v2", """UPDATE migration_runs SET validation = jsonb_set(validation, '{writes,"books (catalog)",Unchanged}', '1')""", "ledger: writes = rows mapped, per target" },
        { "v2", """UPDATE migration_runs SET validation = jsonb_set(validation, '{orphanCandidates}', (SELECT jsonb_agg(o) FROM jsonb_array_elements(validation -> 'orphanCandidates') o WHERE o::text NOT LIKE '%taken down%'))""",
            "report: takedowns (carried hidden, no bytes, no chapters)" },
        { "v2", "INSERT INTO migration_runs (id) VALUES (gen_random_uuid())", "ledger: no run in flight or unclosed" },
        { "v2", """UPDATE migration_runs SET validation = jsonb_set(validation, '{cleanupActions}', (SELECT COALESCE(jsonb_agg(o), '[]') FROM jsonb_array_elements(validation -> 'cleanupActions') o WHERE o::text NOT LIKE '%V2 guest with no legacy row%'))""",
            "report: V2 rows with no legacy row (cleanup lines, never deleted)" },
        { "legacy", $"UPDATE users SET name = 'Renamed' WHERE id = '{ProductionShapes.User(5)}'", "users: legacy vs V2 (count, owner, content)" },
        { "legacy", "INSERT INTO users (id, email, google_subject, created_at) VALUES ('a0000000-0000-4000-8000-000000000999', 'late@test.com', NULL, now())", "ledger: source counts = legacy now" },
    };

    [Theory]
    [MemberData(nameof(Corruptions))]
    public async Task ValidateEtl_ChangedAfterTheRun_ExitsNonZeroNamingTheCheck(string side, string sql, string check)
    {
        var options = await NewPairAsync(sameContainer: true);
        await EtlV2.RunAsync(options, ct: Ct);
        Assert.Equal(0, (await ValidateAsync(options)).ExitCode);
        // Replica mode: V2's own triggers and FKs would refuse some of these; the script must not rely on them.
        await ExecAsync(side == "v2" ? options.Target : options.Source, "SET session_replication_role = replica; " + sql);

        var (exit, stdout, stderr) = await ValidateAsync(options);

        Assert.Equal(3, exit);
        Assert.Contains("validate-etl:", stderr);
        Assert.Contains("FAILED", stderr);
        Assert.Equal("FAIL", Rows(stdout)[check].Status);
    }

    [Fact]
    public async Task ValidateEtl_FailedRun_FailsTheLedgerCheck()
    {
        var options = await NewPairAsync(sameContainer: true);
        await ExecAsync(options.Source, "UPDATE vocabulary_reviews SET review_mode = ' ' WHERE id = '72000000-0000-4000-8000-000000000522'");
        var error = await FailsAsync(options);

        var (exit, stdout, _) = await ValidateAsync(options, error.RunId!.ToString());

        Assert.Equal(3, exit);
        var row = Rows(stdout)["ledger: run succeeded, all its checks passed"];
        Assert.Equal("FAIL", row.Status);
        Assert.StartsWith($"run {error.RunId}: failed, validation_failures 1", row.Details);
    }

    [Fact]
    public async Task ValidateEtl_NoV2Connection_RefusesWithUsage()
    {
        var (exit, _, stderr) = await V2.Databases.RunAsync("psql", "-X", "-U", "postgres", "-d", "postgres", "-f", Script);

        Assert.Equal(3, exit);
        Assert.Contains("pass -v v2=", stderr);
    }

    [Fact]
    public void ValidateEtl_IntentQuery_IsCatalogsIntentPairsVerbatim()
    {
        // The script restates the catalog step's pair selection: a change to one without the other fails here.
        var script = File.ReadAllText(Path.Combine(PostgresFixture.RepoRoot(), "database/v2/scripts/validate-etl.sql"));
        var block = Regex.Match(script, @"-- BEGIN IntentPairs[^\n]*\npair AS \((?<q>.*?)\n\),\n-- END IntentPairs", RegexOptions.Singleline);

        Assert.True(block.Success, "the IntentPairs block markers are gone");
        Assert.Equal(Normalize(EtlV2Catalog.IntentPairs), Normalize(block.Groups["q"].Value));

        static string Normalize(string sql) => Regex.Replace(sql, @"\s+", " ").Trim();
    }

    [Fact]
    public void ValidateEtl_V5Constants_AreEtlV2Ids()
    {
        // The script's namespace literal and its self-test vectors are EtlV2Ids' own.
        var script = File.ReadAllText(Path.Combine(PostgresFixture.RepoRoot(), "database/v2/scripts/validate-etl.sql"));

        Assert.Contains($"'{EtlV2Ids.Namespace}'::uuid, uuid_send(user_id) || uuid_send(edition_id)", script);
        Assert.Contains($"self:ns' = '{EtlV2Ids.Namespace}'", script);
        Assert.Contains($"self:rfc' = '{EtlV2Ids.V5(Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "python.org"u8.ToArray())}'", script);
    }
}
