using Application.Entitlements;
using Application.Vocabulary;
using Domain.Identity;

namespace TextStack.UnitTests;

/// <summary>
/// S12: saving a vocabulary word fires paid LLM enrichment (distractors + hint + explanation).
/// Every rate-limit policy in the API partitions on IP only, so without a per-tier ceiling
/// `POST /auth/guest` + word-saving is a free, account-less path to unmetered inference.
///
/// The cap is expressed as an entitlement rather than as a new mechanism because the meter already
/// exists: enrichment is queued exactly where a word gains `ActivatedAt`, which is what
/// `DailyCapService` already counts. The tier ceiling therefore clamps that cap instead of
/// introducing a second counter that could drift from it.
/// </summary>
public class GuestEnrichmentCapTests
{
    private const long Mb = 1024 * 1024;
    private const int GuestCap = 50;

    private static EntitlementOptions Options(int? guestCap = GuestCap, int? defaultCap = null) =>
        new(
            new TierEntitlements(500 * Mb, null, defaultCap),
            new Dictionary<string, TierEntitlements>
            {
                [nameof(UserTier.Guest)] = new(50 * Mb, 1, guestCap),
                [nameof(UserTier.Free)] = new(500 * Mb, null),
            },
            new HashSet<string>(StringComparer.OrdinalIgnoreCase),
            80 * Mb,
            20480 * Mb);

    private static EntitlementResolver Resolver(EntitlementOptions? options = null) =>
        new(options ?? Options());

    [Fact]
    public void Resolve_Guest_GetsDailyEnrichmentCap()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: true, "guest-abc@guest.local", null);

        Assert.Equal(UserTier.Guest, result.Tier);
        Assert.Equal(GuestCap, result.DailyEnrichmentCap);
    }

    [Fact]
    public void Resolve_RegisteredUser_HasNoDailyEnrichmentCap()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: false, "reader@example.com", null);

        Assert.Null(result.DailyEnrichmentCap);
    }

    [Fact]
    public void DailyEnrichmentCapFor_UnconfiguredTier_InheritsDefault()
    {
        // Same partial inheritance as the other quotas: an unset tier falls back to Default.
        var options = Options(guestCap: null, defaultCap: 200);

        Assert.Equal(200, options.DailyEnrichmentCapFor(UserTier.Guest));
    }

    [Fact]
    public void DailyEnrichmentCapFor_NonPositiveConfig_MeansUnlimited()
    {
        // A mistyped 0 must not lock every guest out of saving a single word — an over-permissive
        // typo costs money and is recoverable, a lockout silently breaks the product's core loop.
        var options = Options(guestCap: 0);

        Assert.Null(options.DailyEnrichmentCapFor(UserTier.Guest));
    }

}
