using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Api.Endpoints;

/// <summary>
/// What a cached dictionary lookup turned out to be. <see cref="NotFound"/> is a NEGATIVE entry:
/// upstream told us the word has no definition. It is cached so a typo does not send a request to
/// a dead service every time it is tapped, but on a much shorter TTL than a hit — dictionaries
/// gain words, they effectively never change the definition of one they already have.
/// </summary>
public enum DictionaryStatus
{
    Hit,
    NotFound,
    Unavailable,
}

/// <summary>One resolved lookup, independent of how it was resolved (cache, upstream, or stale fallback).</summary>
/// <param name="Cached">Answer came off disk rather than from upstream.</param>
/// <param name="Stale">Answer came off disk PAST its TTL, because upstream could not be reached.
/// Still correct data — just not revalidated.</param>
public sealed record DictionaryResolution(
    DictionaryStatus Status,
    DictionaryResponse? Entry,
    bool Cached,
    bool Stale);

/// <summary>
/// The on-disk record. <see cref="CachedAtUtc"/> is stored in the payload rather than read off the
/// file's mtime: a volume restore or a <c>docker cp</c> rewrites mtimes and would make the whole
/// cache look freshly written, which quietly turns the "is this stale?" question into a lie.
/// <see cref="Entry"/> is null for a negative entry.
/// </summary>
public sealed record DictionaryCacheEntry(
    [property: JsonPropertyName("found")] bool Found,
    [property: JsonPropertyName("cachedAtUtc")] DateTime CachedAtUtc,
    [property: JsonPropertyName("entry")] DictionaryResponse? Entry);

/// <summary>
/// The lookup policy, as pure functions over a cache entry — no IO, no clock of its own, no HTTP.
/// This is where the load-bearing rule lives: <b>on upstream failure we serve a stale entry rather
/// than an error</b>. A definition from last month is correct; a 504 is not.
/// </summary>
public static class DictionaryPolicy
{
    /// <summary>
    /// The answer we can give WITHOUT touching upstream, or null meaning "go ask upstream".
    /// Fresh entries (positive or negative) short-circuit; stale ones do not — they are held back
    /// as the fallback for <see cref="OnUpstreamFailure"/>.
    /// </summary>
    public static DictionaryResolution? FromCache(
        DictionaryCacheEntry? cached, DateTime nowUtc, TimeSpan hitTtl, TimeSpan negativeTtl)
    {
        if (cached is null)
            return null;

        var ttl = cached.Found ? hitTtl : negativeTtl;
        if (!IsFresh(cached, nowUtc, ttl))
            return null;

        return cached.Found
            ? new DictionaryResolution(DictionaryStatus.Hit, cached.Entry, Cached: true, Stale: false)
            : new DictionaryResolution(DictionaryStatus.NotFound, null, Cached: true, Stale: false);
    }

    /// <summary>
    /// Upstream is unreachable (timeout, connection failure, or a non-404 error status). Serve
    /// whatever we have at ANY age — there is deliberately no upper bound on how stale a fallback
    /// may be, because the alternative is an error and an error is strictly worse. Nothing cached
    /// is the only case that fails, and it fails as <see cref="DictionaryStatus.Unavailable"/> so
    /// the client can tell "we could not ask" apart from "this word has no definition".
    /// </summary>
    public static DictionaryResolution OnUpstreamFailure(DictionaryCacheEntry? cached) => cached switch
    {
        { Found: true } => new DictionaryResolution(DictionaryStatus.Hit, cached.Entry, Cached: true, Stale: true),
        { Found: false } => new DictionaryResolution(DictionaryStatus.NotFound, null, Cached: true, Stale: true),
        _ => new DictionaryResolution(DictionaryStatus.Unavailable, null, Cached: false, Stale: false),
    };

    /// <summary>An entry written in the future (clock skew) counts as fresh, not as infinitely old.</summary>
    public static bool IsFresh(DictionaryCacheEntry entry, DateTime nowUtc, TimeSpan ttl) =>
        entry.CachedAtUtc != default && nowUtc - entry.CachedAtUtc < ttl;
}

/// <summary>
/// SHA256-keyed file cache for dictionary lookups. Same shape as <c>FileJsonCache</c> (hex key,
/// one JSON file per entry, best-effort IO that degrades to "no cache" rather than failing the
/// request) with two differences that the fallback depends on:
/// <list type="bullet">
///   <item>reads do NOT drop expired entries — they return them flagged, so the endpoint can serve
///     them when upstream is down;</item>
///   <item>writes are tmp+rename, so a container kill mid-write cannot leave a truncated file that
///     later poisons the outage path (same reason <c>EdgeTtsService</c> does it).</item>
/// </list>
/// </summary>
public sealed class DictionaryCache(string cachePath, ILogger logger)
{
    /// <summary>
    /// Key over the NORMALIZED (lang, word) pair, so "Book", "book " and "BOOK" share one entry.
    /// Hit rate is what makes the outage fallback work at all, so the normalization is part of the
    /// contract, not an optimization.
    /// </summary>
    public static string ComputeKey(string lang, string word)
    {
        var normLang = lang.Trim().ToLowerInvariant();
        var normWord = word.Trim().ToLowerInvariant();
        // Length-prefixed, not just separated: both halves come off URL segments, so a plain
        // "lang|word" join lets ("en", "us|book") and ("en|us", "book") hash to the same entry.
        var payload = $"{normLang.Length}:{normLang}:{normWord}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
    }

    public async Task<DictionaryCacheEntry?> TryReadAsync(string key, CancellationToken ct)
    {
        try
        {
            var file = FilePath(key);
            if (!File.Exists(file))
                return null;
            var entry = JsonSerializer.Deserialize<DictionaryCacheEntry>(await File.ReadAllTextAsync(file, ct));
            // A positive entry with no payload is corrupt — treat as a miss, not as a negative.
            if (entry is { Found: true, Entry: null })
                return null;
            return entry;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Dictionary cache read failed for {Key}, falling through to upstream", key);
            return null;
        }
    }

    public Task WriteHitAsync(string key, DictionaryResponse entry, DateTime nowUtc, CancellationToken ct) =>
        WriteAsync(key, new DictionaryCacheEntry(true, nowUtc, entry), ct);

    public Task WriteMissAsync(string key, DateTime nowUtc, CancellationToken ct) =>
        WriteAsync(key, new DictionaryCacheEntry(false, nowUtc, null), ct);

    private async Task WriteAsync(string key, DictionaryCacheEntry entry, CancellationToken ct)
    {
        var file = FilePath(key);
        var tmp = file + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        try
        {
            Directory.CreateDirectory(cachePath);
            await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(entry), ct);
            File.Move(tmp, file, overwrite: true);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Dictionary cache write failed for {Key}", key);
            try
            {
                if (File.Exists(tmp))
                    File.Delete(tmp);
            }
            catch (Exception cleanupEx) when (cleanupEx is UnauthorizedAccessException or IOException)
            {
                // best effort; the sweeper reaps orphaned .tmp files
            }
        }
    }

    private string FilePath(string key) => Path.Combine(cachePath, key + ".json");
}
