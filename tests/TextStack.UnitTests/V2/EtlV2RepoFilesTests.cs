using System.Diagnostics;
using System.Text.RegularExpressions;

namespace TextStack.UnitTests.V2;

/// <summary>The etl-v2 rules that live in repo files, not in code paths: the Makefile recipe and the ETL sources.</summary>
public class EtlV2RepoFilesTests
{
    private static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "Makefile")) && Directory.Exists(Path.Combine(dir.FullName, "database")))
                return dir.FullName;
        throw new InvalidOperationException("repo root not found above " + AppContext.BaseDirectory);
    }

    [Fact]
    public void MakeEtlV2_Recipe_NotEchoed()
    {
        var lines = File.ReadAllLines(Path.Combine(RepoRoot(), "Makefile"));
        var recipe = lines[Array.IndexOf(lines, "etl-v2:") + 1];

        Assert.StartsWith("\t@", recipe);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MakeEtlV2_ConnectionStringsInEnv_PassedByNameOnly(bool set)
    {
        var ct = TestContext.Current.CancellationToken;
        var marker = Path.Combine(Path.GetTempPath(), "etl-make-" + Guid.NewGuid().ToString("N"));
        // make -n prints the command make would run: what ps would show of docker compose.
        var make = new ProcessStartInfo("make", "-n etl-v2 ARGS=--dry-run")
        {
            WorkingDirectory = RepoRoot(),
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
        using var process = Process.Start(make)!;
        var command = await process.StandardOutput.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);

        Assert.DoesNotContain("env-s3cret", command);
        Assert.False(File.Exists(marker), "make expanded $(shell …) in a connection string");
        // Unset: no bare -e, which would blank the compose file's connection strings.
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
        var dir = Path.Combine(RepoRoot(), "backend", "src", "Infrastructure", "Persistence", "Etl");
        var offenders = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"ON\s+CONFLICT\s+DO\s+NOTHING", RegexOptions.IgnoreCase))
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void EtlSourceFiles_Scanned_WriteInlineSqlNotTheApiRepositories()
    {
        // Owner 2026-11-08 (v2-plan §5.2): the repositories stamp now() and refuse duplicate bytes; the ETL carries legacy's.
        var dir = Path.Combine(RepoRoot(), "backend", "src", "Infrastructure", "Persistence", "Etl");
        var offenders = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
            .Where(f => Regex.IsMatch(File.ReadAllText(f), @"\w*Repository\b|Persistence\.Repositories"))
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void EtlReaderScript_Grants_EverySourceTableTheStepsDeclare()
    {
        // etl_reader can read only what the script grants: a step reading one more table fails on production.
        var script = File.ReadAllText(Path.Combine(RepoRoot(), "database", "scripts", "etl-reader.sql"));
        var granted = Regex.Matches(script, @"public\.([a-z_]+)").Select(m => m.Groups[1].Value).ToHashSet();

        Assert.DoesNotContain(Infrastructure.Persistence.Etl.EtlV2.Steps.SelectMany(s => s.Sources), t => !granted.Contains(t));
    }
}
