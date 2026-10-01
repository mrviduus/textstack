using Api.Endpoints;
using Microsoft.Extensions.Logging.Abstractions;

namespace TextStack.UnitTests;

/// <summary>
/// The dictionary lookup policy and its file cache. Everything here is the part of the endpoint
/// that decides what to serve — deliberately pure (or filesystem-only) so the rule that matters,
/// "on upstream failure serve stale rather than error", can be proved without a network or a
/// running stack. The HTTP wiring around it is covered by the integration suite.
/// </summary>
public class DictionaryCacheTests
{
    private static readonly TimeSpan HitTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan NegativeTtl = TimeSpan.FromHours(24);
    private static readonly DateTime Now = new(2026, 9, 6, 12, 0, 0, DateTimeKind.Utc);

    private static DictionaryResponse Entry(string word = "serendipity") => new(
        word,
        "/ˌsɛrənˈdɪpɪti/",
        [new DictionaryMeaning("noun", [new DictionaryDefinition("A fortunate accident.", null)])]);

    private static DictionaryCacheEntry Hit(DateTime at, string word = "serendipity") =>
        new(Found: true, CachedAtUtc: at, Entry: Entry(word));

    private static DictionaryCacheEntry Negative(DateTime at) =>
        new(Found: false, CachedAtUtc: at, Entry: null);

    // ---- freshness ----

    [Fact]
    public void IsFresh_WithinTtl_ReturnsTrue()
    {
        Assert.True(DictionaryPolicy.IsFresh(Hit(Now.AddDays(-29)), Now, HitTtl));
    }

    [Fact]
    public void IsFresh_ExactlyAtTtl_ReturnsFalse()
    {
        // Boundary is exclusive: at exactly TTL the entry is due for revalidation.
        Assert.False(DictionaryPolicy.IsFresh(Hit(Now - HitTtl), Now, HitTtl));
    }

    [Fact]
    public void IsFresh_PastTtl_ReturnsFalse()
    {
        Assert.False(DictionaryPolicy.IsFresh(Hit(Now.AddDays(-31)), Now, HitTtl));
    }

    [Fact]
    public void IsFresh_MissingTimestamp_ReturnsFalse()
    {
        // A default timestamp means we don't know when this was written — revalidate rather than
        // trust it. It stays servable as a stale fallback, which is the safe half of the guess.
        Assert.False(DictionaryPolicy.IsFresh(Hit(default), Now, HitTtl));
    }

    [Fact]
    public void IsFresh_TimestampInFuture_ReturnsTrue()
    {
        // Clock skew between a restored volume and the host must not make every entry look
        // infinitely old and stampede upstream.
        Assert.True(DictionaryPolicy.IsFresh(Hit(Now.AddHours(1)), Now, HitTtl));
    }

    // ---- FromCache: what we can answer without touching upstream ----

    [Fact]
    public void FromCache_FreshHit_ServesWithoutUpstream()
    {
        var result = DictionaryPolicy.FromCache(Hit(Now.AddDays(-1)), Now, HitTtl, NegativeTtl);

        Assert.NotNull(result);
        Assert.Equal(DictionaryStatus.Hit, result.Status);
        Assert.True(result.Cached);
        Assert.False(result.Stale);
        Assert.Equal("serendipity", result.Entry!.Word);
    }

    [Fact]
    public void FromCache_StaleHit_ReturnsNullSoUpstreamIsTried()
    {
        // Stale does NOT short-circuit: we still try to revalidate. The entry is held back as the
        // fallback for OnUpstreamFailure.
        Assert.Null(DictionaryPolicy.FromCache(Hit(Now.AddDays(-31)), Now, HitTtl, NegativeTtl));
    }

    [Fact]
    public void FromCache_FreshNegative_ServesNotFoundWithoutUpstream()
    {
        var result = DictionaryPolicy.FromCache(Negative(Now.AddHours(-2)), Now, HitTtl, NegativeTtl);

        Assert.NotNull(result);
        Assert.Equal(DictionaryStatus.NotFound, result.Status);
        Assert.True(result.Cached);
        Assert.False(result.Stale);
        Assert.Null(result.Entry);
    }

    [Fact]
    public void FromCache_NegativeOlderThanNegativeTtl_ReturnsNull()
    {
        // 48h is comfortably fresh as a HIT and expired as a NEGATIVE — the whole point of the
        // shorter negative TTL. If this ever passes with the hit TTL applied, typos would be
        // pinned as "no such word" for a month.
        var twoDaysOld = Negative(Now.AddHours(-48));

        Assert.Null(DictionaryPolicy.FromCache(twoDaysOld, Now, HitTtl, NegativeTtl));
        Assert.True(DictionaryPolicy.IsFresh(twoDaysOld, Now, HitTtl));
    }

    [Fact]
    public void FromCache_NoEntry_ReturnsNull()
    {
        Assert.Null(DictionaryPolicy.FromCache(null, Now, HitTtl, NegativeTtl));
    }

    // ---- OnUpstreamFailure: the load-bearing rule ----

    [Fact]
    public void OnUpstreamFailure_StaleHit_ServesStaleDefinition()
    {
        var result = DictionaryPolicy.OnUpstreamFailure(Hit(Now.AddDays(-31)));

        Assert.Equal(DictionaryStatus.Hit, result.Status);
        Assert.True(result.Cached);
        Assert.True(result.Stale);
        Assert.Equal("A fortunate accident.", result.Entry!.Definitions[0].Definitions[0].Definition);
    }

    [Fact]
    public void OnUpstreamFailure_VeryOldHit_StillServesIt()
    {
        // There is deliberately NO upper bound on staleness. A definition from three years ago is
        // still correct; a 503 is not.
        var result = DictionaryPolicy.OnUpstreamFailure(Hit(Now.AddYears(-3)));

        Assert.Equal(DictionaryStatus.Hit, result.Status);
        Assert.True(result.Stale);
        Assert.NotNull(result.Entry);
    }

    [Fact]
    public void OnUpstreamFailure_StaleNegative_ServesNotFoundMarkedStale()
    {
        var result = DictionaryPolicy.OnUpstreamFailure(Negative(Now.AddDays(-10)));

        Assert.Equal(DictionaryStatus.NotFound, result.Status);
        Assert.True(result.Stale);
    }

    [Fact]
    public void OnUpstreamFailure_NothingCached_ReturnsUnavailable()
    {
        // The only failing case, and it must NOT be confusable with "this word has no definition".
        var result = DictionaryPolicy.OnUpstreamFailure(null);

        Assert.Equal(DictionaryStatus.Unavailable, result.Status);
        Assert.False(result.Cached);
        Assert.False(result.Stale);
        Assert.Null(result.Entry);
    }

    [Fact]
    public void OnUpstreamFailure_UnavailableIsDistinctFromNotFound()
    {
        Assert.NotEqual(
            DictionaryPolicy.OnUpstreamFailure(null).Status,
            DictionaryPolicy.OnUpstreamFailure(Negative(Now)).Status);
    }

    // ---- key derivation ----

    [Theory]
    [InlineData("Book")]
    [InlineData("BOOK")]
    [InlineData("  book  ")]
    [InlineData("bOoK")]
    public void ComputeKey_CaseAndWhitespaceVariants_ShareOneEntry(string variant)
    {
        // Hit rate is what makes the outage fallback work, so normalization is part of the
        // contract: a reader tapping "Book" at the start of a sentence must reuse "book".
        Assert.Equal(DictionaryCache.ComputeKey("en", "book"), DictionaryCache.ComputeKey("en", variant));
    }

    [Fact]
    public void ComputeKey_DifferentLanguage_ProducesDifferentKey()
    {
        Assert.NotEqual(DictionaryCache.ComputeKey("en", "hallo"), DictionaryCache.ComputeKey("de", "hallo"));
    }

    [Fact]
    public void ComputeKey_DifferentWord_ProducesDifferentKey()
    {
        Assert.NotEqual(DictionaryCache.ComputeKey("en", "book"), DictionaryCache.ComputeKey("en", "books"));
    }

    [Fact]
    public void ComputeKey_SeparatorCannotBeForged()
    {
        // "en" + "|" + "us|book" must not collide with "en|us" + "|" + "book". Words come off a
        // URL segment, so a pipe in the input is reachable.
        Assert.NotEqual(DictionaryCache.ComputeKey("en", "us|book"), DictionaryCache.ComputeKey("en|us", "book"));
    }

    [Fact]
    public void ComputeKey_IsFilesystemSafeHex()
    {
        var key = DictionaryCache.ComputeKey("en", "naïve / ?*");

        Assert.Equal(64, key.Length);
        Assert.All(key, c => Assert.Contains(c, "0123456789abcdef"));
    }

    // ---- file cache (temp dir, no network) ----

    [Fact]
    public async Task TryReadAsync_AfterWriteHit_RoundTripsEntry()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "serendipity");

        await cache.WriteHitAsync(key, Entry(), Now, TestContext.Current.CancellationToken);
        var read = await cache.TryReadAsync(key, TestContext.Current.CancellationToken);

        Assert.NotNull(read);
        Assert.True(read.Found);
        Assert.Equal(Now, read.CachedAtUtc);
        Assert.Equal("serendipity", read.Entry!.Word);
        Assert.Equal("/ˌsɛrənˈdɪpɪti/", read.Entry.Phonetic);
        Assert.Equal("A fortunate accident.", read.Entry.Definitions[0].Definitions[0].Definition);
    }

    [Fact]
    public async Task TryReadAsync_AfterWriteMiss_ReturnsNegativeEntry()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "asdfghjkl");

        await cache.WriteMissAsync(key, Now, TestContext.Current.CancellationToken);
        var read = await cache.TryReadAsync(key, TestContext.Current.CancellationToken);

        Assert.NotNull(read);
        Assert.False(read.Found);
        Assert.Null(read.Entry);
    }

    [Fact]
    public async Task TryReadAsync_ExpiredEntry_StillReturnsItForStaleFallback()
    {
        // The one place this cache deliberately differs from FileJsonCache: expiry is decided by the
        // POLICY, not by the reader dropping the file. If the read swallowed expired entries the
        // outage fallback would have nothing to serve.
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "serendipity");
        var writtenAt = Now.AddYears(-2);

        await cache.WriteHitAsync(key, Entry(), writtenAt, TestContext.Current.CancellationToken);
        var read = await cache.TryReadAsync(key, TestContext.Current.CancellationToken);

        Assert.NotNull(read);
        Assert.False(DictionaryPolicy.IsFresh(read, Now, HitTtl));
        Assert.Equal(DictionaryStatus.Hit, DictionaryPolicy.OnUpstreamFailure(read).Status);
    }

    [Fact]
    public async Task TryReadAsync_MissingFile_ReturnsNull()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);

        Assert.Null(await cache.TryReadAsync(
            DictionaryCache.ComputeKey("en", "never-written"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TryReadAsync_CorruptFile_ReturnsNullInsteadOfThrowing()
    {
        // A truncated file from a container kill must degrade to a cache miss, not 500 the request.
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "book");
        await File.WriteAllTextAsync(
            Path.Combine(dir.Path, key + ".json"), "{\"found\":true,\"entry\":{\"wo",
            TestContext.Current.CancellationToken);

        Assert.Null(await cache.TryReadAsync(key, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TryReadAsync_PositiveEntryWithoutPayload_ReturnsNull()
    {
        // found=true with no entry is corrupt. Returning it would let OnUpstreamFailure serve a
        // 200 with a null body during an outage — worse than the outage.
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "book");
        await File.WriteAllTextAsync(
            Path.Combine(dir.Path, key + ".json"),
            "{\"found\":true,\"cachedAtUtc\":\"2026-09-06T12:00:00Z\",\"entry\":null}",
            TestContext.Current.CancellationToken);

        Assert.Null(await cache.TryReadAsync(key, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task WriteHitAsync_UnwritablePath_DoesNotThrow()
    {
        // Cache IO is best-effort: a permissions problem on the volume degrades to "no cache",
        // it does not take the endpoint down with it.
        using var dir = new TempDir();
        var blocked = Path.Combine(dir.Path, "not-a-dir");
        await File.WriteAllTextAsync(blocked, "x", TestContext.Current.CancellationToken);
        var cache = new DictionaryCache(blocked, NullLogger.Instance);

        await cache.WriteHitAsync("abc", Entry(), Now, TestContext.Current.CancellationToken);
        Assert.Null(await cache.TryReadAsync("abc", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task WriteAsync_LeavesNoTempFilesBehind()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);

        await cache.WriteHitAsync("a", Entry(), Now, TestContext.Current.CancellationToken);
        await cache.WriteMissAsync("b", Now, TestContext.Current.CancellationToken);

        Assert.Empty(Directory.GetFiles(dir.Path, "*.tmp"));
        Assert.Equal(2, Directory.GetFiles(dir.Path, "*.json").Length);
    }

    [Fact]
    public async Task WriteHitAsync_OverwritesExistingEntry()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "book");

        await cache.WriteMissAsync(key, Now.AddDays(-1), TestContext.Current.CancellationToken);
        await cache.WriteHitAsync(key, Entry("book"), Now, TestContext.Current.CancellationToken);
        var read = await cache.TryReadAsync(key, TestContext.Current.CancellationToken);

        Assert.NotNull(read);
        Assert.True(read.Found);
        Assert.Equal(Now, read.CachedAtUtc);
    }

    // ---- the outage, end to end over the pure pieces ----

    [Fact]
    public async Task PrimedCache_WhenUpstreamFails_ServesStaleInsteadOfError()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);
        var key = DictionaryCache.ComputeKey("en", "Serendipity"); // reader taps a capitalised word
        var primedAt = Now.AddDays(-90);

        // 1. Cache was primed three months ago, when upstream was healthy.
        await cache.WriteHitAsync(key, Entry(), primedAt, TestContext.Current.CancellationToken);

        // 2. Today the entry is past its 30-day TTL, so we would go upstream...
        var cached = await cache.TryReadAsync(
            DictionaryCache.ComputeKey("en", "serendipity"), TestContext.Current.CancellationToken);
        Assert.NotNull(cached);
        Assert.Null(DictionaryPolicy.FromCache(cached, Now, HitTtl, NegativeTtl));

        // 3. ...upstream is down (522/timeout). The reader still gets the definition.
        var served = DictionaryPolicy.OnUpstreamFailure(cached);
        Assert.Equal(DictionaryStatus.Hit, served.Status);
        Assert.True(served.Stale);
        Assert.Equal("A fortunate accident.", served.Entry!.Definitions[0].Definitions[0].Definition);
    }

    [Fact]
    public async Task UnprimedCache_WhenUpstreamFails_ReportsUnavailableNotNotFound()
    {
        using var dir = new TempDir();
        var cache = new DictionaryCache(dir.Path, NullLogger.Instance);

        var cached = await cache.TryReadAsync(
            DictionaryCache.ComputeKey("en", "hapax"), TestContext.Current.CancellationToken);

        Assert.Equal(DictionaryStatus.Unavailable, DictionaryPolicy.OnUpstreamFailure(cached).Status);
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "ts-dict-cache-" + Guid.NewGuid().ToString("N")[..8]);

        public TempDir() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }
}
