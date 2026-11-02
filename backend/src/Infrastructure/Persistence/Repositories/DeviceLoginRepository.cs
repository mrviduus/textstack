using Application.Common;
using Application.Identity;
using Dapper;
using Domain.Identity;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IDeviceLoginRepository"/> on <c>textstack_v2</c>. Every
/// transition is one UPDATE guarded by the status it leaves, so of two racing callers one matches.
/// A user code shows at most one pending login (<c>ix_device_authorizations_user_code</c>, unique
/// and partial): decided logins may show it again.
/// </summary>
public sealed class DeviceLoginRepository(V2DataSource dataSource) : IDeviceLoginRepository
{
    private const string Columns = "id, device_code_hash, user_code, user_id, status, expires_at, interval_seconds, consumed_at, created_at";

    private const string InsertLogin = """
        INSERT INTO device_authorizations (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
        VALUES (@Id, @DeviceCodeHash, @UserCode, @Status, @ExpiresAt, @IntervalSeconds, now())
        """;

    public async Task<bool> CreateAsync(DeviceLogin login, CancellationToken ct)
    {
        try
        {
            await using var conn = await dataSource.OpenConnectionAsync(ct);
            return await conn.ExecuteAsync(new CommandDefinition(InsertLogin, login, cancellationToken: ct)) > 0;
        }
        // A pending login shows the code: the caller mints another. Reachable (a random code), so a result.
        catch (PostgresException e) when (e.IsUniqueViolation() && e.ConstraintName == "ix_device_authorizations_user_code")
        {
            return false;
        }
    }

    // The deadline first: a login past it is expired whoever asks. An approval then needs the
    // approver's access token to outlive the last password reset; otherwise the login stays pending
    // and that is the answer. The approver's row FOR SHARE, so a reset committing meanwhile is seen
    // (and one that comes after finds the approval and expires it). A denial matches no user. At most
    // one pending login shows a code (ix_device_authorizations_user_code).
    private const string Decide = $"""
        WITH approver AS (SELECT {UserRepository.FreshUserExists} AS fresh)
        UPDATE device_authorizations SET
            status = CASE
                WHEN expires_at <= @now THEN 'expired'
                WHEN @userId IS NULL THEN 'denied'
                WHEN (SELECT fresh FROM approver) THEN 'approved'
                ELSE status END,
            user_id = CASE WHEN expires_at > @now AND (SELECT fresh FROM approver) THEN @userId END
        WHERE user_code = @userCode AND status = 'pending'
        RETURNING status
        """;

    public async Task<string?> DecideAsync(string userCode, Guid? approvedBy, DateTimeOffset? tokenIssuedAt, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(
            Decide, new { userCode, userId = approvedBy, tokenIssuedAt, now }, cancellationToken: ct));
    }

    private const string SelectByDeviceCode = $"SELECT {Columns} FROM device_authorizations WHERE device_code_hash = @deviceCodeHash";

    public async Task<DeviceLogin?> GetByDeviceCodeAsync(string deviceCodeHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<DeviceLogin>(new CommandDefinition(SelectByDeviceCode, new { deviceCodeHash }, cancellationToken: ct));
    }

    // The approver's row FOR SHARE first: the lock order of SessionTokenRepository.
    private const string LockApprover = """
        SELECT FROM users
        WHERE id = (SELECT user_id FROM device_authorizations WHERE id = @loginId AND status = 'approved')
        FOR SHARE
        """;

    private const string RedeemApproved = $"""
        WITH redeemed AS (
            UPDATE device_authorizations SET status = 'expired', consumed_at = now()
            WHERE id = @loginId AND status = 'approved' AND expires_at > @now
            RETURNING user_id)
        {SessionTokenRepository.InsertSessionFromUser} WHERE u.id IN (SELECT user_id FROM redeemed)
        """;

    public async Task<bool> RedeemAsync(Guid loginId, string tokenHash, DateTimeOffset sessionExpiresAt, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(LockApprover, new { loginId }, tx, cancellationToken: ct));
        var redeemed = await conn.ExecuteAsync(new CommandDefinition(
            RedeemApproved, new { id = Guid.NewGuid(), loginId, tokenHash, kind = SessionTokenRepository.Kind(SessionKind.Reader), expiresAt = sessionExpiresAt, now }, tx, cancellationToken: ct)) > 0;
        await tx.CommitAsync(ct);
        return redeemed;
    }

    private const string DeleteExpired = "DELETE FROM device_authorizations WHERE expires_at < @expiredBefore";

    public async Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteExpired, new { expiredBefore }, cancellationToken: ct));
    }
}
