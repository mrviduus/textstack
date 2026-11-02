using System.Collections.Concurrent;
using Domain.Entities;
using Domain.Identity;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

public enum ShadowOutcome
{
    Ready,

    /// <summary>A different V2 account holds the email; not merged here (M2.5's job): V2 is unavailable to this user.</summary>
    EmailHeld,
}

/// <summary>
/// M2.2's bridge, removed by M2.5: V2 rows reference V2 <c>users</c>, which the ETL (M3) fills, but
/// until auth moves to V2 the session user lives in the legacy database. Before a V2 request runs,
/// the user gets a V2 row with the same id (id, email, guest flag; everything else default), and
/// the ETL upserts into the rows this created. The caller reads the legacy account on every request
/// (a deleted account must stop at 401); only "the V2 row is ensured" is remembered, for <see cref="Ttl"/>,
/// so a request costs no write, and a V2 row that vanished (an ETL reset, a rollback) is ensured again.
/// </summary>
public sealed class V2ShadowUsers(IUserRepository users, TimeProvider clock, ILogger<V2ShadowUsers> logger)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    // ponytail: per process, so each api replica writes once; within the TTL a V2 row deleted under
    // a live entry still fails the request on its FK until the entry expires.
    private readonly ConcurrentDictionary<Guid, (ShadowOutcome Outcome, DateTimeOffset Until)> _known = new();

    public async Task<ShadowOutcome> EnsureAsync(User legacy, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (_known.TryGetValue(legacy.Id, out var known) && now < known.Until) return known.Outcome;

        var created = await users.CreateAsync(new UserAccount { Id = legacy.Id, Email = legacy.Email, IsGuest = legacy.IsGuest }, ct);
        // Null: something unique is taken. The id itself (a concurrent request, or the ETL) is fine.
        var outcome = created is not null || await users.GetAsync(legacy.Id, ct) is not null ? ShadowOutcome.Ready : ShadowOutcome.EmailHeld;
        // ponytail: EmailHeld (a case variant of a legacy email, a deleted account's email reused) is a
        // permanent per-account refusal the PDD has no code for, so it answers v2_unavailable; M2.5
        // moves auth to V2 and the bridge, with this case, goes away.
        if (outcome == ShadowOutcome.EmailHeld)
            logger.LogWarning("V2 shadow user {UserId}: its email is held by another V2 account; /me/v2 answers 503 for it", legacy.Id);
        _known[legacy.Id] = (outcome, now + Ttl);
        return outcome;
    }
}
