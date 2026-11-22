using Application.Entitlements;
using Domain.Identity;

namespace TextStack.UnitTests;

/// <summary>
/// "AI needs a real account" is a product policy, and this is where it is decided — one flag on the
/// tier, resolved once, enforced at the route by <c>RequireAiAccount</c>.
///
/// It has to live server-side because the mobile client's <c>canUseAi = isAccount</c> is a UI
/// affordance, not a boundary: a guest session mints a valid bearer token, so every paid-inference
/// endpoint was reachable with an IP rate limit as its only barrier.
/// </summary>
public class GuestAiAccessTests
{
    private const long Mb = 1024 * 1024;

    private static EntitlementOptions Options(bool? guestAi = false, bool? defaultAi = null) =>
        new(
            new TierEntitlements(500 * Mb, null, null, defaultAi),
            new Dictionary<string, TierEntitlements>
            {
                [nameof(UserTier.Guest)] = new(50 * Mb, 1, 50, guestAi),
                [nameof(UserTier.Free)] = new(500 * Mb, null),
                [nameof(UserTier.Staff)] = new(5120 * Mb, null),
            },
            new HashSet<string>(StringComparer.OrdinalIgnoreCase),
            80 * Mb,
            20480 * Mb);

    private static EntitlementResolver Resolver(EntitlementOptions? options = null) =>
        new(options ?? Options());

    [Fact]
    public void Resolve_Guest_CannotUseAi()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: true, "guest-abc@guest.local", null);

        Assert.Equal(UserTier.Guest, result.Tier);
        Assert.False(result.CanUseAi);
    }

    [Fact]
    public void Resolve_RegisteredUser_CanUseAi()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: false, "reader@example.com", null);

        Assert.True(result.CanUseAi);
    }

    [Fact]
    public void Resolve_GuestWithAStaffEmail_StillCannotUseAi()
    {
        // Guest emails are synthesized, so a collision with the staff allowlist must not hand an
        // anonymous session the staff grant. Guest wins over everything — fail closed.
        var options = new EntitlementOptions(
            new TierEntitlements(500 * Mb, null),
            new Dictionary<string, TierEntitlements>
            {
                [nameof(UserTier.Guest)] = new(50 * Mb, 1, 50, false),
                [nameof(UserTier.Staff)] = new(5120 * Mb, null),
            },
            new HashSet<string>(["staff@textstack.app"], StringComparer.OrdinalIgnoreCase),
            80 * Mb,
            20480 * Mb);

        var result = Resolver(options).Resolve(UserTier.Free, isGuest: true, "staff@textstack.app", null);

        Assert.Equal(UserTier.Guest, result.Tier);
        Assert.False(result.CanUseAi);
    }

    [Fact]
    public void AiEnabledFor_UnconfiguredTier_AllowsRatherThanBlocks()
    {
        // A missing or mistyped key must cost us a call we meant to gate — visible on the OpenAI
        // bill — not silently kill AI for every paying user, which is invisible until churn.
        var options = Options(guestAi: null);

        Assert.True(options.AiEnabledFor(UserTier.Guest));
        Assert.True(options.AiEnabledFor(UserTier.Supporter)); // tier absent from config entirely
    }

    [Fact]
    public void AiEnabledFor_DefaultSectionFalse_IsInheritedByUnsetTiers()
    {
        // Partial inheritance, same as the other quotas: a tier that says nothing takes Default's word.
        var options = Options(guestAi: null, defaultAi: false);

        Assert.False(options.AiEnabledFor(UserTier.Guest));
        Assert.False(options.AiEnabledFor(UserTier.Free));
    }

    [Fact]
    public void AiEnabledFor_TierOverridesDefault()
    {
        var options = Options(guestAi: true, defaultAi: false);

        Assert.True(options.AiEnabledFor(UserTier.Guest));
    }
}
