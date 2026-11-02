using System.Linq.Expressions;
using Application.Auth;
using Application.Common;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// <see cref="IOAuthRepository"/> on the legacy database (#1100): the queries <c>OAuthEndpoints</c>
/// and <c>McpKeyAuthMiddleware</c> ran inline. Every one-time step (approve, deny, burn, rotate,
/// revoke) is one guarded <c>ExecuteUpdate</c>, as on V2. Legacy has no password-reset stamp, so
/// <c>tokenIssuedAt</c> and the consent-after-reset check are not applied.
/// </summary>
public sealed class EfOAuthRepository(IAppDbContext db) : IOAuthRepository
{
    private static readonly Expression<Func<OAuthClient, OAuthClientRegistration>> ToClient = c => new OAuthClientRegistration
    {
        Id = c.Id,
        ClientId = c.ClientId,
        ClientName = c.ClientName,
        RedirectUris = c.RedirectUris,
        IsMetadataDocument = c.IsMetadataDocument,
        FetchedAt = c.FetchedAt,
        CreatedAt = c.CreatedAt,
    };

    private static readonly Expression<Func<OAuthAuthorizationRequest, OAuthAuthorization>> ToRequest = r => new OAuthAuthorization
    {
        Id = r.Id,
        ClientId = r.ClientId,
        ClientName = r.ClientName,
        RedirectUri = r.RedirectUri,
        State = r.State,
        CodeChallenge = r.CodeChallenge,
        Resource = r.Resource,
        Scope = r.Scope,
        ExpiresAt = r.ExpiresAt,
        UserId = r.UserId,
        CodeHash = r.CodeHash,
        DeniedAt = r.DeniedAt,
        ConsumedAt = r.ConsumedAt,
        CreatedAt = r.CreatedAt,
    };

    private static readonly Expression<Func<OAuthGrant, OAuthTokenGrant>> ToGrant = g => new OAuthTokenGrant
    {
        Id = g.Id,
        UserId = g.UserId,
        ClientId = g.ClientId,
        ClientName = g.ClientName,
        RedirectUri = g.RedirectUri,
        Resource = g.Resource,
        Scope = g.Scope,
        AccessTokenHash = g.AccessTokenHash,
        AccessTokenExpiresAt = g.AccessTokenExpiresAt,
        RefreshTokenHash = g.RefreshTokenHash,
        RefreshTokenExpiresAt = g.RefreshTokenExpiresAt,
        PreviousRefreshTokenHash = g.PreviousRefreshTokenHash,
        LastUsedAt = g.LastUsedAt,
        RevokedAt = g.RevokedAt,
        CreatedAt = g.CreatedAt,
    };

    public Task<OAuthClientRegistration?> GetClientAsync(string clientId, CancellationToken ct) =>
        db.OAuthClients.AsNoTracking().Where(c => c.ClientId == clientId).Select(ToClient).FirstOrDefaultAsync(ct);

    public async Task<OAuthClientRegistration> SaveClientAsync(OAuthClientRegistration client, CancellationToken ct)
    {
        if (await RefreshClientAsync(client, ct) == 0)
        {
            var row = new OAuthClient
            {
                Id = client.Id,
                ClientId = client.ClientId,
                ClientName = client.ClientName,
                RedirectUris = client.RedirectUris,
                IsMetadataDocument = client.IsMetadataDocument,
                FetchedAt = client.FetchedAt,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            db.OAuthClients.Add(row);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            // A concurrent first fetch of the same metadata document inserted it: last write wins.
            catch (DbUpdateException e) when (e.IsUniqueViolation())
            {
                db.OAuthClients.Entry(row).State = EntityState.Detached;
                await RefreshClientAsync(client, ct);
            }
        }
        return (await GetClientAsync(client.ClientId, ct))!;
    }

    private Task<int> RefreshClientAsync(OAuthClientRegistration client, CancellationToken ct) =>
        db.OAuthClients.Where(c => c.ClientId == client.ClientId).ExecuteUpdateAsync(s => s
            .SetProperty(c => c.ClientName, client.ClientName)
            .SetProperty(c => c.RedirectUris, client.RedirectUris)
            .SetProperty(c => c.FetchedAt, client.FetchedAt), ct);

    public async Task CreateRequestAsync(OAuthAuthorization request, CancellationToken ct)
    {
        db.OAuthAuthorizationRequests.Add(new OAuthAuthorizationRequest
        {
            Id = request.Id,
            ClientId = request.ClientId,
            ClientName = request.ClientName,
            RedirectUri = request.RedirectUri,
            State = request.State,
            CodeChallenge = request.CodeChallenge,
            Resource = request.Resource,
            Scope = request.Scope,
            ExpiresAt = request.ExpiresAt,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);
    }

    public Task<OAuthAuthorization?> GetRequestAsync(Guid requestId, CancellationToken ct) =>
        db.OAuthAuthorizationRequests.AsNoTracking().Where(r => r.Id == requestId).Select(ToRequest).FirstOrDefaultAsync(ct);

    // The consent page's "pending": neither decided nor past its deadline.
    private IQueryable<OAuthAuthorizationRequest> Pending(Guid requestId, DateTimeOffset now) =>
        db.OAuthAuthorizationRequests.Where(r => r.Id == requestId && r.DeniedAt == null && r.UserId == null && r.ExpiresAt > now);

    public async Task<OAuthAuthorization?> ApproveRequestAsync(
        Guid requestId, Guid userId, string codeHash, DateTimeOffset codeExpiresAt, DateTimeOffset tokenIssuedAt, DateTimeOffset now, CancellationToken ct)
    {
        var approved = await Pending(requestId, now)
            .Where(_ => db.Users.Any(u => u.Id == userId))
            .ExecuteUpdateAsync(s => s
                .SetProperty(r => r.UserId, userId)
                .SetProperty(r => r.CodeHash, codeHash)
                .SetProperty(r => r.ExpiresAt, codeExpiresAt), ct);
        return approved == 0 ? null : await GetRequestAsync(requestId, ct);
    }

    public async Task<bool> DenyRequestAsync(Guid requestId, DateTimeOffset now, CancellationToken ct) =>
        await Pending(requestId, now).ExecuteUpdateAsync(s => s.SetProperty(r => r.DeniedAt, now), ct) > 0;

    public Task<OAuthAuthorization?> GetRequestByCodeAsync(string codeHash, CancellationToken ct) =>
        db.OAuthAuthorizationRequests.AsNoTracking().Where(r => r.CodeHash == codeHash).Select(ToRequest).FirstOrDefaultAsync(ct);

    public async Task<bool> BurnCodeAsync(Guid requestId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.OAuthAuthorizationRequests
            .Where(r => r.Id == requestId && r.ConsumedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.ConsumedAt, now), ct) > 0;
    }

    public Task<int> DeleteRequestsCreatedBeforeAsync(DateTimeOffset createdBefore, CancellationToken ct) =>
        db.OAuthAuthorizationRequests.Where(r => r.CreatedAt < createdBefore).ExecuteDeleteAsync(ct);

    // The replaced grants are revoked in the same SaveChanges as the insert, so the swap is atomic.
    public async Task<bool> ConnectAsync(Guid userId, Guid requestId, OAuthTokenGrant grant, CancellationToken ct)
    {
        if (!await db.OAuthAuthorizationRequests.AnyAsync(r => r.Id == requestId && r.UserId == userId, ct)) return false;

        // The host is compared as the consent screen shows it (OAuth.DisplayHost), which SQL cannot reproduce.
        var now = DateTimeOffset.UtcNow;
        var host = OAuth.DisplayHost(grant.RedirectUri);
        var live = await db.OAuthGrants
            .Where(g => g.UserId == userId && g.ClientName == grant.ClientName && g.RevokedAt == null)
            .ToListAsync(ct);
        foreach (var old in live.Where(g => OAuth.DisplayHost(g.RedirectUri) == host))
            old.RevokedAt = now;

        db.OAuthGrants.Add(new OAuthGrant
        {
            Id = grant.Id,
            UserId = userId,
            ClientId = grant.ClientId,
            ClientName = grant.ClientName,
            RedirectUri = grant.RedirectUri,
            Resource = grant.Resource,
            Scope = grant.Scope,
            AccessTokenHash = grant.AccessTokenHash,
            AccessTokenExpiresAt = grant.AccessTokenExpiresAt,
            RefreshTokenHash = grant.RefreshTokenHash,
            RefreshTokenExpiresAt = grant.RefreshTokenExpiresAt,
            CreatedAt = now,
        });
        await db.SaveChangesAsync(ct);
        return true;
    }

    public Task<OAuthTokenGrant?> GetByRefreshTokenAsync(string refreshTokenHash, CancellationToken ct) =>
        db.OAuthGrants.AsNoTracking().Where(g => g.RefreshTokenHash == refreshTokenHash && g.RevokedAt == null).Select(ToGrant).FirstOrDefaultAsync(ct);

    // ponytail: remembers one generation back; an older spent token is refused but not treated as reuse.
    public async Task<int> RevokeOnRefreshReuseAsync(string refreshTokenHash, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.OAuthGrants
            .Where(g => g.PreviousRefreshTokenHash == refreshTokenHash && g.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.RevokedAt, now), ct);
    }

    public async Task<bool> RotateAsync(
        Guid grantId, string oldRefreshTokenHash,
        string accessTokenHash, DateTimeOffset accessTokenExpiresAt,
        string refreshTokenHash, DateTimeOffset refreshTokenExpiresAt,
        CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.OAuthGrants
            .Where(g => g.Id == grantId && g.RefreshTokenHash == oldRefreshTokenHash && g.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(g => g.AccessTokenHash, accessTokenHash)
                .SetProperty(g => g.AccessTokenExpiresAt, accessTokenExpiresAt)
                .SetProperty(g => g.PreviousRefreshTokenHash, oldRefreshTokenHash)
                .SetProperty(g => g.RefreshTokenHash, refreshTokenHash)
                .SetProperty(g => g.RefreshTokenExpiresAt, refreshTokenExpiresAt)
                .SetProperty(g => g.LastUsedAt, now), ct) > 0;
    }

    public async Task<int> RevokeByTokenAsync(string tokenHash, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.OAuthGrants
            .Where(g => (g.AccessTokenHash == tokenHash || g.RefreshTokenHash == tokenHash) && g.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.RevokedAt, now), ct);
    }

    public Task<OAuthTokenGrant?> GetByAccessTokenAsync(string accessTokenHash, string resource, DateTimeOffset now, CancellationToken ct) =>
        db.OAuthGrants.AsNoTracking().Where(OAuth.LiveAccessToken(accessTokenHash, resource, now)).Select(ToGrant).FirstOrDefaultAsync(ct);

    public async Task TouchAsync(Guid grantId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        await db.OAuthGrants.Where(g => g.Id == grantId).ExecuteUpdateAsync(s => s.SetProperty(g => g.LastUsedAt, now), ct);
    }

    public async Task<IReadOnlyList<OAuthTokenGrant>> ListLiveAsync(Guid userId, DateTimeOffset now, CancellationToken ct) =>
        await db.OAuthGrants.AsNoTracking()
            .Where(g => g.UserId == userId && g.RevokedAt == null && g.RefreshTokenExpiresAt > now)
            .OrderByDescending(g => g.CreatedAt).ThenByDescending(g => g.Id)
            .Select(ToGrant)
            .ToListAsync(ct);

    // Keeps the first revocation time: the audit answer is "when was it turned off".
    public async Task<bool> RevokeAsync(Guid userId, Guid grantId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.OAuthGrants
            .Where(g => g.Id == grantId && g.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.RevokedAt, g => g.RevokedAt ?? now), ct) > 0;
    }

    public Task<int> DeleteDeadGrantsAsync(DateTimeOffset before, CancellationToken ct) =>
        db.OAuthGrants.Where(g => g.RevokedAt < before || g.RefreshTokenExpiresAt < before).ExecuteDeleteAsync(ct);
}
