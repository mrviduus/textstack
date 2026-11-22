namespace Domain.Identity;

/// <summary>
/// What a reader is entitled to. Persisted as a STRING (<c>users.tier</c>), so the member
/// *names* are the storage contract — renaming one is a breaking change requiring a data migration.
///
/// The numeric order is nonetheless load-bearing: it is monotonically increasing in generosity, so
/// "at least this tier" comparisons and any future <c>Math.Max</c>-style resolution stay correct.
/// Insert new tiers in the right place in the ordering, and never renumber an existing one.
///
/// The per-tier limits themselves are NOT here — they live in configuration
/// (<c>Entitlements:Tiers</c>) so that changing a quota is a config edit, not a deploy of new code.
/// </summary>
public enum UserTier
{
    /// <summary>Anonymous session. Deliberately the most restricted: one book, small quota.</summary>
    Guest = 0,

    /// <summary>A registered account. The default for every real user.</summary>
    Free = 1,

    /// <summary>Reserved for the future paid tier. Nothing grants it yet.</summary>
    Supporter = 2,

    /// <summary>The people who run TextStack. Granted by <c>Entitlements:StaffEmails</c>.</summary>
    Staff = 3,
}
