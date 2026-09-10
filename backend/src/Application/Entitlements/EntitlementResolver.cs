using Domain.Entities;
using Domain.Enums;

namespace Application.Entitlements;

/// <summary>What a specific user may do, right now. Everything already resolved and clamped —
/// callers must not re-derive any of it.</summary>
/// <param name="DailyEnrichmentCap">New vocabulary words this user may push through paid LLM
/// enrichment per UTC day; <c>null</c> = uncapped (every tier but Guest, today).</param>
/// <param name="CanUseAi">
/// Whether the paid-inference surface (tutor)
/// is open to this user. This is the SERVER's answer — the mobile client has its own
/// <c>canUseAi</c> flag, but a client-side flag is a UI affordance, not a boundary: a guest token
/// is a valid bearer token, so without this every one of those endpoints was reachable with an
/// IP rate limit as its only barrier.
/// </param>
public sealed record UserEntitlements(
    UserTier Tier,
    long StorageLimitBytes,
    int? MaxBooks,
    long MaxSingleUploadBytes,
    int? DailyEnrichmentCap,
    bool CanUseAi);

public interface IEntitlementResolver
{
    UserEntitlements Resolve(User user);
}

/// <summary>
/// The single place that answers "what is this user allowed to do". Before this existed the answer
/// was a ternary on <c>IsGuest</c> duplicated at two call sites against two compiled-in constants;
/// adding a third kind of user was not expressible at all.
/// </summary>
public sealed class EntitlementResolver(EntitlementOptions options) : IEntitlementResolver
{
    public UserEntitlements Resolve(User user) =>
        Resolve(user.Tier, user.IsGuest, user.Email, user.StorageLimitOverrideBytes);

    /// <summary>
    /// The whole decision, as a pure function — no DB, no DI, no clock. This is what the tests
    /// exercise; the instance method above is just a projection of a <see cref="User"/> onto it.
    /// </summary>
    public UserEntitlements Resolve(
        UserTier persistedTier, bool isGuest, string? email, long? storageOverrideBytes)
    {
        var tier = EffectiveTier(persistedTier, isGuest, email);

        var storage = storageOverrideBytes is { } over && over > 0
            ? options.ClampStorageLimit(over)
            : options.StorageLimitBytesFor(tier);

        return new UserEntitlements(
            tier,
            storage,
            options.MaxBooksFor(tier),
            options.MaxSingleUploadBytes,
            options.DailyEnrichmentCapFor(tier),
            options.AiEnabledFor(tier));
    }

    /// <summary>
    /// Guest wins over everything — fail-closed. Guest emails are synthesized
    /// (<c>guest-{guid}@guest.local</c>), so consulting the staff allowlist for a guest would let an
    /// unlucky collision mint an anonymous session with the staff quota. A guest is a guest.
    /// </summary>
    public UserTier EffectiveTier(UserTier persistedTier, bool isGuest, string? email)
    {
        if (isGuest) return UserTier.Guest;
        return options.IsStaffEmail(email) ? UserTier.Staff : persistedTier;
    }
}
