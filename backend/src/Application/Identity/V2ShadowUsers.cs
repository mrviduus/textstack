using Application.Common.Interfaces;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// M2.2's bridge, removed when identity switches to V2 (M5.1): V2 rows reference V2 <c>users</c>, which the ETL (M3) fills, but
/// until auth moves to V2 the session user lives in the legacy database. Before a V2 request runs,
/// the user gets a V2 row with the same id (id, email, guest flag; everything else default), and
/// the ETL upserts into the rows this created. The outcome is cached for <see cref="Ttl"/>, so a
/// request costs no write; <see cref="Forget"/> drops it when a V2 row turns out to be gone.
/// </summary>
public sealed class V2ShadowUsers(IUserRepository users, IMemoryCache cache, ILogger<V2ShadowUsers> logger)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    /// <summary>Whether the session still names a legacy account: a deleted one's live token must stop here.</summary>
    public static Task<bool> HasLegacyAccountAsync(IAppDbContext legacy, Guid userId, CancellationToken ct) =>
        legacy.Users.AnyAsync(u => u.Id == userId, ct);

    /// <summary>The legacy account as its shadow row needs it (id, email, guest flag); null when it is gone.</summary>
    public static Task<UserAccount?> GetLegacyAccountAsync(IAppDbContext legacy, Guid userId, CancellationToken ct) =>
        LegacyAccount(legacy, userId).SingleOrDefaultAsync(ct);

    private static IQueryable<UserAccount> LegacyAccount(IAppDbContext legacy, Guid userId) =>
        legacy.Users.Where(u => u.Id == userId).Select(u => new UserAccount { Id = u.Id, Email = u.Email, IsGuest = u.IsGuest });

    /// <summary>
    /// True when the user's V2 row is there (made now, or already). False when another V2 account
    /// holds the email: a case variant of a legacy email, or a deleted account's email reused.
    /// </summary>
    public async Task<bool> EnsureAsync(IAppDbContext legacy, Guid userId, CancellationToken ct, bool readOnly = false)
    {
        // During the cutover freeze a read may use an existing shadow, but must never create one.
        if (readOnly) return await users.GetAsync(userId, ct) is not null;
        if (cache.TryGetValue(Key(userId), out bool ready)) return ready;

        // Only on a miss: the three columns the shadow row needs.
        return await CreateAsync(await LegacyAccount(legacy, userId).SingleAsync(ct), ct);
    }

    /// <summary>
    /// <see cref="EnsureAsync(IAppDbContext, Guid, CancellationToken, bool)"/> with the legacy account already read
    /// (<see cref="GetLegacyAccountAsync"/>): V2 calls only, so a caller can tell a V2 fault from a legacy one.
    /// </summary>
    public async Task<bool> EnsureAsync(UserAccount legacyAccount, CancellationToken ct, bool readOnly = false)
    {
        if (readOnly) return await users.GetAsync(legacyAccount.Id, ct) is not null;
        if (cache.TryGetValue(Key(legacyAccount.Id), out bool ready)) return ready;
        return await CreateAsync(legacyAccount, ct);
    }

    private async Task<bool> CreateAsync(UserAccount account, CancellationToken ct)
    {
        var userId = account.Id;
        // Null: something unique is taken; the id itself (a concurrent request, the ETL) is fine. The
        // re-read is a second statement on purpose: in the insert's snapshot a concurrent first request's
        // row is invisible, and that user would be refused for the whole TTL.
        var ready = await users.CreateAsync(account, ct) is not null || await users.GetAsync(userId, ct) is not null;
        // ponytail: the PDD has no code for this permanent per-account refusal, so it is v2_unavailable
        // until M2.5 moves auth to V2 and the bridge goes.
        if (!ready)
            logger.LogWarning("V2 shadow user {UserId}: its email is held by another V2 account; /me/v2 answers 503 for it", userId);
        cache.Set(Key(userId), ready, Ttl);
        return ready;
    }

    public void Forget(Guid userId) => cache.Remove(Key(userId));

    private static (string, Guid) Key(Guid userId) => ("v2-shadow-user", userId);
}
