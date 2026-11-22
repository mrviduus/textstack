using Application.Entitlements;
using Domain.Identity;

namespace TextStack.UnitTests;

/// <summary>
/// The single place that decides what a reader may do. Before this existed the answer was a ternary
/// on <c>IsGuest</c> duplicated at two call sites against two compiled-in constants, and a third
/// kind of user was not expressible at all.
///
/// Two properties matter more than the arithmetic: a broken config must degrade to a WORKING
/// default rather than to zero (a mistyped quota that locks every user out of uploading is an
/// outage), and a guest must never be able to acquire a staff grant.
/// </summary>
public class EntitlementResolverTests
{
    private const long Mb = 1024 * 1024;

    private static EntitlementOptions Options(
        long? guest = 50 * Mb, long? free = 500 * Mb, long? staff = 5120 * Mb,
        int? guestMaxBooks = 1, string[]? staffEmails = null,
        long maxSingleUpload = 80 * Mb, long maxStorage = 20480 * Mb,
        long? defaultStorage = 500 * Mb) =>
        new(
            new TierEntitlements(defaultStorage, null),
            new Dictionary<string, TierEntitlements>
            {
                [nameof(UserTier.Guest)] = new(guest, guestMaxBooks),
                [nameof(UserTier.Free)] = new(free, null),
                [nameof(UserTier.Staff)] = new(staff, null),
            },
            new HashSet<string>(staffEmails ?? [], StringComparer.OrdinalIgnoreCase),
            maxSingleUpload,
            maxStorage);

    private static EntitlementResolver Resolver(EntitlementOptions? options = null) =>
        new(options ?? Options());

    [Fact]
    public void Resolve_Guest_GetsGuestQuotaAndOneBookCap()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: true, "guest-abc@guest.local", null);

        Assert.Equal(UserTier.Guest, result.Tier);
        Assert.Equal(50 * Mb, result.StorageLimitBytes);
        Assert.Equal(1, result.MaxBooks);
    }

    [Fact]
    public void Resolve_RegisteredUser_GetsFreeQuotaAndNoBookCap()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: false, "reader@example.com", null);

        Assert.Equal(500 * Mb, result.StorageLimitBytes);
        Assert.Null(result.MaxBooks);
    }

    [Fact]
    public void Resolve_StaffEmail_IsPromotedRegardlessOfPersistedTier()
    {
        var result = Resolver(Options(staffEmails: ["owner@textstack.app"]))
            .Resolve(UserTier.Free, isGuest: false, "owner@textstack.app", null);

        Assert.Equal(UserTier.Staff, result.Tier);
        Assert.Equal(5120 * Mb, result.StorageLimitBytes);
    }

    [Fact]
    public void Resolve_StaffEmail_MatchesCaseInsensitivelyAndIgnoresSurroundingSpace()
    {
        var result = Resolver(Options(staffEmails: ["  Owner@TextStack.app  "]))
            .Resolve(UserTier.Free, isGuest: false, "owner@textstack.app", null);

        Assert.Equal(UserTier.Staff, result.Tier);
    }

    /// <summary>
    /// Fail-closed. Guest emails are synthesized (<c>guest-{guid}@guest.local</c>); if the allowlist
    /// were consulted for guests, one unlucky collision would mint an anonymous 5 GB session.
    /// </summary>
    [Fact]
    public void Resolve_GuestWithStaffEmail_StaysGuest()
    {
        var result = Resolver(Options(staffEmails: ["owner@textstack.app"]))
            .Resolve(UserTier.Staff, isGuest: true, "owner@textstack.app", null);

        Assert.Equal(UserTier.Guest, result.Tier);
        Assert.Equal(50 * Mb, result.StorageLimitBytes);
    }

    [Fact]
    public void Resolve_PerUserOverride_WinsOverTier()
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: false, "reader@example.com", 3072 * Mb);

        Assert.Equal(3072 * Mb, result.StorageLimitBytes);
    }

    [Fact]
    public void Resolve_OverrideAboveMaxStorage_IsClamped()
    {
        var result = Resolver(Options(maxStorage: 1024 * Mb))
            .Resolve(UserTier.Free, isGuest: false, "reader@example.com", 999_999 * Mb);

        Assert.Equal(1024 * Mb, result.StorageLimitBytes);
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    public void Resolve_NonPositiveOverride_IsIgnoredInFavourOfTier(long over)
    {
        var result = Resolver().Resolve(UserTier.Free, isGuest: false, "reader@example.com", over);

        Assert.Equal(500 * Mb, result.StorageLimitBytes);
    }

    /// <summary>A misconfigured quota must never resolve to zero — that would stop every upload.</summary>
    [Theory]
    [InlineData(0L)]
    [InlineData(-5L)]
    public void Resolve_TierConfiguredAsZeroOrNegative_FallsBackToDefault(long broken)
    {
        var result = Resolver(Options(free: broken)).Resolve(UserTier.Free, false, "r@example.com", null);

        Assert.Equal(500 * Mb, result.StorageLimitBytes);
    }

    [Fact]
    public void Resolve_EverythingUnconfigured_FallsBackToCompiledInLimit()
    {
        var result = new EntitlementResolver(EntitlementOptions.Empty)
            .Resolve(UserTier.Free, false, "r@example.com", null);

        Assert.Equal(EntitlementOptions.FallbackStorageLimitBytes, result.StorageLimitBytes);
        Assert.True(result.StorageLimitBytes > 0);
    }

    [Fact]
    public void Resolve_TierMissingFromConfig_InheritsDefault()
    {
        var result = Resolver().Resolve(UserTier.Supporter, false, "r@example.com", null);

        Assert.Equal(500 * Mb, result.StorageLimitBytes);
    }

    /// <summary>
    /// A typo'd <c>0</c> means "unlimited", not "locked out" — the same degrade-to-no-enforcement
    /// choice the budget options make. An over-permissive typo is recoverable; a lockout is not.
    /// </summary>
    [Fact]
    public void MaxBooksFor_ConfiguredAsZero_MeansUnlimited() =>
        Assert.Null(Options(guestMaxBooks: 0).MaxBooksFor(UserTier.Guest));

    /// <summary>The platform ceiling is not a tier perk and cannot be raised from config.</summary>
    [Fact]
    public void MaxSingleUploadBytes_IsTheSameForEveryTier()
    {
        var resolver = Resolver(Options(staffEmails: ["owner@textstack.app"]));

        var guest = resolver.Resolve(UserTier.Guest, true, "guest-x@guest.local", null);
        var staff = resolver.Resolve(UserTier.Free, false, "owner@textstack.app", null);

        Assert.Equal(guest.MaxSingleUploadBytes, staff.MaxSingleUploadBytes);
        Assert.True(staff.MaxSingleUploadBytes <= EntitlementOptions.PlatformSingleRequestCeilingBytes);
    }
}
