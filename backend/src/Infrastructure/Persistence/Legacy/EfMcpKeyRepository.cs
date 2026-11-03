using System.Linq.Expressions;
using Application.Common;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// <see cref="IMcpKeyRepository"/> on the legacy database (#1100): what <c>McpKeysEndpoints</c> and
/// <c>McpKeyAuthMiddleware</c> did inline. Legacy has no password-reset stamp, so
/// <c>tokenIssuedAt</c> is not checked; a key is still refused to a user that is gone.
/// </summary>
public sealed class EfMcpKeyRepository(IAppDbContext db) : IMcpKeyRepository
{
    private static readonly Expression<Func<McpAccessKey, McpConnectKey>> ToKey = k => new McpConnectKey
    {
        Id = k.Id,
        UserId = k.UserId,
        Name = k.Name,
        KeyHash = k.KeyHash,
        Prefix = k.Prefix,
        LastUsedAt = k.LastUsedAt,
        RevokedAt = k.RevokedAt,
        CreatedAt = k.CreatedAt,
    };

    private static readonly Func<McpAccessKey, McpConnectKey> AsKey = ToKey.Compile();

    public async Task<IReadOnlyList<McpConnectKey>> ListAsync(Guid userId, CancellationToken ct) =>
        await db.McpAccessKeys.AsNoTracking()
            .Where(k => k.UserId == userId)
            .OrderByDescending(k => k.CreatedAt).ThenByDescending(k => k.Id)
            .Select(ToKey)
            .ToListAsync(ct);

    public Task<int> CountLiveAsync(Guid userId, CancellationToken ct) =>
        db.McpAccessKeys.CountAsync(k => k.UserId == userId && k.RevokedAt == null, ct);

    public async Task<McpConnectKey?> CreateAsync(Guid userId, string name, string keyHash, string prefix, DateTimeOffset tokenIssuedAt, CancellationToken ct)
    {
        // A guest mints no key (#1120). EF has no INSERT … SELECT, so legacy asks first; a guest only ever
        // becomes an account, never the reverse, so the gap can only refuse one that just signed up.
        if (await db.Users.AnyAsync(u => u.Id == userId && u.IsGuest, ct)) return null;

        var key = new McpAccessKey
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = name,
            KeyHash = keyHash,
            Prefix = prefix,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.McpAccessKeys.Add(key);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        // The user is gone: the users FK refuses the key.
        catch (DbUpdateException e) when (e.IsForeignKeyViolation())
        {
            db.McpAccessKeys.Entry(key).State = EntityState.Detached;
            return null;
        }
        return AsKey(key);
    }

    // Keeps the first revocation time: the audit answer is "when was it turned off".
    public async Task<bool> RevokeAsync(Guid userId, Guid keyId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.McpAccessKeys
            .Where(k => k.Id == keyId && k.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(k => k.RevokedAt, k => k.RevokedAt ?? now), ct) > 0;
    }

    public Task<McpConnectKey?> GetLiveByHashAsync(string keyHash, CancellationToken ct) =>
        // A guest's key (minted before #1120) authenticates nothing.
        db.McpAccessKeys.AsNoTracking().Where(k => k.KeyHash == keyHash && k.RevokedAt == null && !k.User.IsGuest).Select(ToKey).FirstOrDefaultAsync(ct);

    public async Task TouchAsync(Guid keyId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        await db.McpAccessKeys.Where(k => k.Id == keyId).ExecuteUpdateAsync(s => s.SetProperty(k => k.LastUsedAt, now), ct);
    }
}
