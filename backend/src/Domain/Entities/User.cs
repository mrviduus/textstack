using Domain.Enums;

namespace Domain.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public string? Name { get; set; }
    public string? Picture { get; set; }
    public string? PasswordHash { get; set; }
    public string? GoogleSubject { get; set; }
    public string? AppleSubject { get; set; }
    public long StorageUsedBytes { get; set; }
    public bool IsGuest { get; set; }

    /// <summary>
    /// Entitlement tier. The limits it maps to live in <c>Entitlements:Tiers</c> config, never here —
    /// resolve them through <c>IEntitlementResolver</c> rather than switching on this directly.
    /// </summary>
    public UserTier Tier { get; set; } = UserTier.Free;

    /// <summary>
    /// Per-user storage grant that wins over the tier. For genuine one-offs (a support gesture, a
    /// beta tester) — not a substitute for creating a tier. Clamped to
    /// <c>Entitlements:MaxStorageLimitBytes</c> on read, so a stray value here cannot hand out the
    /// whole disk. Null = use the tier.
    /// </summary>
    public long? StorageLimitOverrideBytes { get; set; }
    public DateTimeOffset? LastActiveAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    /// <summary>When a guest row was promoted IN PLACE to an account (email registration). Null for
    /// accounts created directly and for guests merged into another account (that row is deleted;
    /// the merge is logged as <c>guest_merged</c> instead).</summary>
    public DateTimeOffset? PromotedAt { get; set; }
    /// <summary>BCP-47 language code for the user's native language (the one they already know).
    /// Drives translation direction, dictionary hint language, and dismisses the onboarding pulse
    /// across devices. Null = not yet set; falls back to client-side detection.</summary>
    public string? NativeLanguage { get; set; }

    public ICollection<ReadingProgress> ReadingProgresses { get; set; } = [];
    public ICollection<Bookmark> Bookmarks { get; set; } = [];
    public ICollection<Note> Notes { get; set; } = [];
    public ICollection<UserLibrary> UserLibraries { get; set; } = [];
    public ICollection<UserBook> UserBooks { get; set; } = [];
    public ICollection<Highlight> Highlights { get; set; } = [];
}
