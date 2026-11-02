using System.Collections.Concurrent;
using Domain.Entities;
using Domain.Identity;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

public enum ShadowOutcome
{
    Ready,

    /// <summary>The session names no legacy account (deleted since the token was issued).</summary>
    NoAccount,

    /// <summary>A different V2 account holds the email; not merged here (M2.5's job): V2 is unavailable to this user.</summary>
    EmailHeld,
}

/// <summary>
/// M2.2's bridge, removed by M2.5: V2 rows reference V2 <c>users</c>, which the ETL (M3) fills, but
/// until auth moves to V2 the session user lives in the legacy database. Before a V2 request runs,
/// the user gets a V2 row with the same id (id, email, guest flag; everything else default), and
/// the ETL upserts into the rows this created. Ids seen once are remembered for the process's life,
/// so a request costs no write.
/// </summary>
public sealed class V2ShadowUsers(IUserRepository users, ILogger<V2ShadowUsers> logger)
{
    // ponytail: never invalidated, so a legacy account delete or guest merge leaves the V2 row (and
    // what it owns) behind until M2.5 moves both onto V2; per process, so each api replica writes once.
    private readonly ConcurrentDictionary<Guid, byte> _present = new();

    /// <param name="legacyUser">Reads the session user from the legacy database; called only for an id not seen yet.</param>
    public async Task<ShadowOutcome> EnsureAsync(Guid userId, Func<Task<User?>> legacyUser, CancellationToken ct)
    {
        if (_present.ContainsKey(userId)) return ShadowOutcome.Ready;
        var legacy = await legacyUser();
        if (legacy is null) return ShadowOutcome.NoAccount;

        var created = await users.CreateAsync(new UserAccount { Id = legacy.Id, Email = legacy.Email, IsGuest = legacy.IsGuest }, ct);
        // Null: something unique is taken. The id itself (a concurrent request, or the ETL) is fine.
        if (created is null && await users.GetAsync(userId, ct) is null)
        {
            logger.LogError("V2 shadow user {UserId}: its email is held by another V2 account; /me/v2 answers 503 for it", userId);
            return ShadowOutcome.EmailHeld;
        }
        _present[userId] = 0;
        return ShadowOutcome.Ready;
    }
}
