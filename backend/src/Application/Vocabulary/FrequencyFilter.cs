using System.IO.Compression;
using System.Text.Json;

namespace Application.Vocabulary;

// Anti-spiral F1: classifies a tapped word by corpus frequency.
//
// Tiers:
//   rank 1..TierInstantMax     → SrsEligible    — common word, straight to SRS
//   rank ..TierCommitMax       → RequiresRetap  — user must tap 2x before it enters SRS
//   rank > TierCommitMax / OOV → LookupOnly     — goes to WordLookup (reference only)
//
// Data: the embedded Vocabulary/Data/wordfreq-en.json.gz (hermitdave en_50k, OpenSubtitles-derived,
// top 20k ≥ Zipf 2.0), read once per process. English only: any other language fails open to
// SrsEligible — there is no data to filter it with.
public enum FrequencyClassKind
{
    SrsEligible,
    RequiresRetap,
    LookupOnly,
}

public record FrequencyClassification(
    FrequencyClassKind Kind,
    int? ZipfRank,
    double? ZipfScore,
    int RequiredTaps,
    string? Reason);

public interface IFrequencyFilter
{
    Task<FrequencyClassification> ClassifyAsync(string word, string language, int currentTapCount, CancellationToken ct);
}

public class FrequencyFilter : IFrequencyFilter
{
    public const int TierInstantMax = 5000;
    public const int TierCommitMax = 15000;
    public const int RetapRequired = 2;
    private const string Language = "en";
    private const string ResourceName = "Application.Vocabulary.Data.wordfreq-en.json.gz";

    private static readonly Lazy<Dictionary<string, Entry>> Words = new(Load);

    public Task<FrequencyClassification> ClassifyAsync(string word, string language, int currentTapCount, CancellationToken ct) =>
        Task.FromResult(Classify(word, language, currentTapCount));

    public static FrequencyClassification Classify(string word, string language, int currentTapCount)
    {
        if (!string.Equals(language, Language, StringComparison.OrdinalIgnoreCase))
            return new(FrequencyClassKind.SrsEligible, null, null, 1, null);

        // OOV — not in the top 20k. Treat as rare; no rank/zipf.
        if (!Words.Value.TryGetValue(word.ToLowerInvariant(), out var e))
            return new(FrequencyClassKind.LookupOnly, null, null, 0, "rare_word");

        if (e.Rank <= TierInstantMax)
            return new(FrequencyClassKind.SrsEligible, e.Rank, e.Zipf, 1, null);

        if (e.Rank <= TierCommitMax)
        {
            if (currentTapCount + 1 >= RetapRequired)
                return new(FrequencyClassKind.SrsEligible, e.Rank, e.Zipf, RetapRequired, null);
            return new(FrequencyClassKind.RequiresRetap, e.Rank, e.Zipf, RetapRequired, "mid_tier");
        }

        return new(FrequencyClassKind.LookupOnly, e.Rank, e.Zipf, 0, "rare_word");
    }

    private static Dictionary<string, Entry> Load()
    {
        using var stream = typeof(FrequencyFilter).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource {ResourceName} is missing");
        using var gz = new GZipStream(stream, CompressionMode.Decompress);
        var entries = JsonSerializer.Deserialize<List<Entry>>(gz, JsonSerializerOptions.Web) ?? [];
        return entries.ToDictionary(x => x.Word.ToLowerInvariant());
    }

    private sealed record Entry(string Word, int Rank, double Zipf);
}
