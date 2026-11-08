using System.Text.Json;
using System.Text.RegularExpressions;
using Infrastructure.Persistence.Etl;

namespace Api.V2;

/// <summary>
/// <c>etl-v2 [--dry-run] [--source &lt;cs&gt;] [--target &lt;cs&gt;] [--source-dump-sha &lt;hex&gt;]</c> (v2-plan §5.2):
/// the source defaults to <c>ConnectionStrings:Default</c>, the target to <c>ConnectionStrings:V2</c> (prefer
/// those, set by env: argv is visible in ps). Prints the report as JSON; exit 0 done, 1 refused or failed,
/// 2 usage, 130 cancelled.
/// </summary>
public static class EtlV2Command
{
    private const string Usage = "usage: etl-v2 [--dry-run] [--source <connection string>] [--target <connection string>] [--source-dump-sha <64 lowercase hex>]";

    // \z, not $: $ also matches before a trailing newline.
    private static readonly Regex Sha256Hex = new(@"\A[0-9a-f]{64}\z", RegexOptions.Compiled);

    // Npgsql's password keys and aliases (Password, PWD, PSW, SSL Password), anywhere in the string.
    private static readonly Regex PasswordKey = new(@"(?:^|;)\s*(?:ssl\s*password|password|pwd|psw)\s*=", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private const string PasswordInArgv =
        "etl-v2: a password on the command line is visible in ps; set it in ConnectionStrings__Default / ConnectionStrings__V2 "
        + "(env), or point the string at a pgpass file (Passfile=<path>)";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static async Task<int> RunAsync(string[] args, IConfiguration config, TextWriter output, TextWriter error, CancellationToken ct = default)
    {
        if (args.Any(PasswordKey.IsMatch))
        {
            await error.WriteLineAsync(PasswordInArgv);
            return 2;
        }
        var options = Parse(args, config);
        if (options is null)
        {
            await error.WriteLineAsync(Usage);
            return 2;
        }
        try
        {
            var report = await EtlV2.RunAsync(options, ct: ct);
            await output.WriteLineAsync(JsonSerializer.Serialize(report, Json));
            return 0;
        }
        catch (EtlV2CanceledException e)
        {
            // 130 only when a ledger row records the cancel; before it, an ordinary failure.
            await error.WriteLineAsync($"etl-v2: {e.Message}");
            return e.RunId is null ? 1 : 130;
        }
        catch (InvalidOperationException e)
        {
            // The message only: EtlV2 scrubs it, the inner exception it wraps it does not.
            await error.WriteLineAsync($"etl-v2: {e.Message}");
            return 1;
        }
    }

    /// <summary>
    /// The options, or null on an unknown argument, a flag without its value, a bad dump hash, or no
    /// connection string. A password on the command line is refused before this, by <see cref="RunAsync"/>.
    /// </summary>
    public static EtlV2Options? Parse(string[] args, IConfiguration config)
    {
        var (dryRun, source, target) = (false, config.GetConnectionString("Default"), config.GetConnectionString("V2"));
        string? sourceDumpSha = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--dry-run":
                    dryRun = true;
                    break;
                case "--source" when i + 1 < args.Length:
                    source = args[++i];
                    break;
                case "--target" when i + 1 < args.Length:
                    target = args[++i];
                    break;
                case "--source-dump-sha" when i + 1 < args.Length && Sha256Hex.IsMatch(args[i + 1]):
                    sourceDumpSha = args[++i];
                    break;
                default:
                    return null;
            }
        }
        return string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(target) ? null : new EtlV2Options(source, target, dryRun, sourceDumpSha);
    }
}
