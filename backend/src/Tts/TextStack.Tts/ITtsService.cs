namespace TextStack.Tts;

public interface ITtsService
{
    Task<byte[]> SynthesizeAsync(string text, string lang, string? voice = null, double speed = 1.0, CancellationToken ct = default);
    Task<TtsSynthesisResult> SynthesizeWithTimestampsAsync(string text, string lang, string? voice = null, double speed = 1.0, CancellationToken ct = default);
    Task<IReadOnlyList<TtsVoiceInfo>> GetVoicesAsync(string? lang = null, CancellationToken ct = default);
}

public record TtsVoiceInfo(string Name, string ShortName, string Gender, string Locale, string Language);

// Offsets already account for the speed/rate parameter — use them as-is against
// audio currentTime on the client (no post-scaling needed).
public record WordTimestamp(string Word, double StartMs, double DurationMs);

public record TtsSynthesisResult(byte[] Audio, IReadOnlyList<WordTimestamp> Timestamps);

// No Edge voice speaks this language (#1334). Input-driven, not an outage.
public class TtsNoVoiceException(string lang) : Exception($"No TTS voice for language '{lang}'")
{
    public string Lang { get; } = lang;
}
