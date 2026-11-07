using System.Text.Json;
using Infrastructure.Persistence.Etl;

namespace Api.V2;

/// <summary>
/// <c>etl-v2 [--dry-run] [--source &lt;cs&gt;] [--target &lt;cs&gt;]</c> (v2-plan §5.2): the source defaults to
/// <c>ConnectionStrings:Default</c>, the target to <c>ConnectionStrings:V2</c>. Prints the report as JSON;
/// exit 0 done, 1 refused or failed, 2 usage.
/// </summary>
public static class EtlV2Command
{
    private const string Usage = "usage: etl-v2 [--dry-run] [--source <connection string>] [--target <connection string>]";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static async Task<int> RunAsync(string[] args, IConfiguration config, TextWriter output, TextWriter error)
    {
        var options = Parse(args, config);
        if (options is null)
        {
            await error.WriteLineAsync(Usage);
            return 2;
        }
        try
        {
            var report = await EtlV2.RunAsync(options);
            await output.WriteLineAsync(JsonSerializer.Serialize(report, Json));
            return 0;
        }
        catch (InvalidOperationException e)
        {
            // The message only: EtlV2 scrubs it, the inner exception it wraps it does not.
            await error.WriteLineAsync($"etl-v2: {e.Message}");
            return 1;
        }
    }

    /// <summary>The options, or null on an unknown argument, a flag without its value, or no connection string.</summary>
    public static EtlV2Options? Parse(string[] args, IConfiguration config)
    {
        var (dryRun, source, target) = (false, config.GetConnectionString("Default"), config.GetConnectionString("V2"));
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
                default:
                    return null;
            }
        }
        return string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(target) ? null : new EtlV2Options(source, target, dryRun);
    }
}
