using Application.Entitlements;
using Domain.Enums;

namespace TextStack.UnitTests;

/// <summary>
/// A resolver wired to the production tier numbers, for tests that need a `UserBookService` but are
/// not themselves about entitlements. Using the real values (rather than `EntitlementOptions.Empty`)
/// keeps quota assertions in those tests meaningful — a guest really does get 50 MB and one book.
/// Entitlement behaviour itself is covered by `EntitlementResolverTests`.
/// </summary>
public static class TestEntitlements
{
    private const long Mb = 1024 * 1024;

    public const long GuestStorageBytes = 50 * Mb;
    public const long FreeStorageBytes = 500 * Mb;
    public const long StaffStorageBytes = 5120 * Mb;

    /// <summary>Matches appsettings: guests get 50 paid enrichments per UTC day, accounts none —
    /// and the paid-inference surface (tutor) is closed to them entirely.</summary>
    public const int GuestDailyEnrichmentCap = 50;

    public static EntitlementOptions Options { get; } = new(
        new TierEntitlements(FreeStorageBytes, null),
        new Dictionary<string, TierEntitlements>
        {
            [nameof(UserTier.Guest)] = new(GuestStorageBytes, 1, GuestDailyEnrichmentCap, AiEnabled: false),
            [nameof(UserTier.Free)] = new(FreeStorageBytes, null),
            [nameof(UserTier.Supporter)] = new(2048 * Mb, null),
            [nameof(UserTier.Staff)] = new(StaffStorageBytes, null),
        },
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        80 * Mb,
        20480 * Mb);

    public static IEntitlementResolver Resolver { get; } = new EntitlementResolver(Options);
}
