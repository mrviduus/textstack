using Domain.Enums;

namespace Application.Entitlements;

/// <summary>What one tier is allowed. <c>null</c> means "not configured" — never "zero".</summary>
/// <param name="DailyEnrichmentCap">
/// New vocabulary words this tier may push through paid LLM enrichment per UTC day.
/// <c>null</c> = uncapped. Defaulted so existing positional constructions keep compiling.
/// </param>
/// <param name="AiEnabled">
/// Whether this tier may reach the paid-inference surface (tutor).
/// <c>null</c> = inherit <c>Default</c>, then allow.
/// </param>
public sealed record TierEntitlements(
    long? StorageLimitBytes,
    int? MaxBooks,
    int? DailyEnrichmentCap = null,
    bool? AiEnabled = null);

/// <summary>
/// Per-tier quotas, bound from the <c>Entitlements</c> config section. Pure: no DI, no I/O, and it
/// never throws — a typo in configuration degrades to a safe default rather than failing startup.
/// Shape deliberately mirrors <see cref="TextStack.Ai.Llm.BudgetOptions"/>, which already solved
/// this problem in this codebase and is unit-tested standalone.
///
/// The one structural decision worth reading twice: <see cref="MaxSingleUploadBytes"/> lives on THIS
/// record and not on <see cref="TierEntitlements"/>. It is a platform constraint, not a perk, so
/// there is deliberately nowhere to express "Staff may upload bigger files" — see the field docs.
/// </summary>
public sealed record EntitlementOptions(
    TierEntitlements Default,
    IReadOnlyDictionary<string, TierEntitlements> Tiers,
    IReadOnlySet<string> StaffEmails,
    long MaxSingleUploadBytes,
    long MaxStorageLimitBytes)
{
    /// <summary>
    /// Hard ceiling on ONE request body, imposed by Cloudflare and not by us. Verified against
    /// production: a 90 MB body reached the API, a 110 MB body was rejected with
    /// <c>413 cloudflare</c>. nginx (500M) and Kestrel (500M) are NOT the constraint, so raising
    /// them changes nothing. Files above this must go through the chunked upload endpoints.
    /// Configuration can only LOWER the effective value; the binder clamps to this.
    /// </summary>
    public const long PlatformSingleRequestCeilingBytes = 100L * 1024 * 1024;

    /// <summary>Last-resort storage grant when configuration says nothing usable. Deliberately the
    /// historical Free limit, so a broken config degrades to today's behaviour, not to zero.</summary>
    public const long FallbackStorageLimitBytes = 500L * 1024 * 1024;

    public static EntitlementOptions Empty { get; } = new(
        new TierEntitlements(null, null),
        new Dictionary<string, TierEntitlements>(),
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        PlatformSingleRequestCeilingBytes,
        MaxStorageLimitBytesFallback);

    private const long MaxStorageLimitBytesFallback = 20L * 1024 * 1024 * 1024;

    /// <summary>
    /// Storage grant for a tier. Cannot return 0: an absent or non-positive configured value falls
    /// through to <see cref="Default"/> and then to <see cref="FallbackStorageLimitBytes"/>, because
    /// a mistyped quota must never brick every upload in the product.
    /// </summary>
    public long StorageLimitBytesFor(UserTier tier)
    {
        if (Lookup(tier).StorageLimitBytes is { } configured && configured > 0)
            return configured;
        if (Default.StorageLimitBytes is { } fallback && fallback > 0)
            return fallback;
        return FallbackStorageLimitBytes;
    }

    /// <summary>
    /// Book-count cap, or null for unlimited. A configured <c>&lt;= 0</c> normalizes to unlimited
    /// rather than to "locked out" — same reasoning as the budget options' mode fallback: an
    /// over-permissive typo is recoverable, a lockout is an outage.
    /// </summary>
    public int? MaxBooksFor(UserTier tier)
    {
        var configured = Lookup(tier).MaxBooks ?? Default.MaxBooks;
        return configured is > 0 ? configured : null;
    }

    /// <summary>
    /// How many new words this tier may push through paid LLM enrichment per UTC day, or null for
    /// unlimited. Saving a word fires distractor + hint + explanation generation, so without this a
    /// <c>POST /auth/guest</c> loop is an account-less path to paid inference.
    /// </summary>
    /// <remarks>
    /// Same normalization as <see cref="MaxBooksFor"/> — a configured <c>&lt;= 0</c> means unlimited,
    /// not "nobody may ever save a word". Deliberately: an over-permissive typo costs money and is
    /// recoverable, a lockout silently breaks the product's core loop for everyone. The guest number
    /// is the one that matters and it is set explicitly in <c>appsettings.json</c>.
    /// </remarks>
    public int? DailyEnrichmentCapFor(UserTier tier)
    {
        var configured = Lookup(tier).DailyEnrichmentCap ?? Default.DailyEnrichmentCap;
        return configured is > 0 ? configured : null;
    }

    /// <summary>
    /// May this tier reach the paid-inference surface at all? This is the ON/OFF switch that sits
    /// above <see cref="DailyEnrichmentCapFor"/>: the cap meters a feature a tier HAS, this decides
    /// whether it has it. Today only Guest is off.
    /// </summary>
    /// <remarks>
    /// Unset means allowed, deliberately — the failure mode of a mistyped or missing key is then
    /// "we pay for a call we meant to gate", which shows up on the OpenAI bill, rather than "AI is
    /// silently dead for every paying user", which shows up as churn. Same doctrine as
    /// <see cref="MaxBooksFor"/>. Guest's <c>false</c> is written explicitly in appsettings.
    /// </remarks>
    public bool AiEnabledFor(UserTier tier) =>
        Lookup(tier).AiEnabled ?? Default.AiEnabled ?? true;

    /// <summary>
    /// Normalized once, here, rather than trusting whoever built the set. Configuration is
    /// hand-edited, so a trailing space or a capitalized domain is a matter of when, not if — and
    /// the failure mode (staff silently not recognized) is invisible. Keeping this inside the type
    /// means every construction path gets it, including tests that build options directly.
    /// </summary>
    private readonly HashSet<string> _normalizedStaffEmails = StaffEmails
        .Where(e => !string.IsNullOrWhiteSpace(e))
        .Select(e => e.Trim())
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>Staff grant by email. Never consulted for guests — see the resolver.</summary>
    public bool IsStaffEmail(string? email) =>
        !string.IsNullOrWhiteSpace(email) && _normalizedStaffEmails.Contains(email.Trim());

    /// <summary>Bounds a per-user override so a stray row cannot hand out the whole disk.</summary>
    public long ClampStorageLimit(long candidate) =>
        Math.Clamp(candidate, 0, MaxStorageLimitBytes > 0 ? MaxStorageLimitBytes : MaxStorageLimitBytesFallback);

    /// <summary>Unknown tier inherits <see cref="Default"/> — partial inheritance, as BudgetOptions.</summary>
    private TierEntitlements Lookup(UserTier tier) =>
        Tiers.TryGetValue(tier.ToString(), out var t) ? t : Default;
}
