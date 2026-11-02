using Application.Identity;
using Dapper;
using Domain.Identity;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IDeviceLoginRepository"/> on <c>textstack_v2</c>. Every
/// transition is one UPDATE guarded by the status it leaves, so of two racing callers one matches.
/// A user code is unique only among pending logins (<c>ix_device_authorizations_user_code</c> is
/// partial and not unique): old decided logins may show it again.
/// </summary>
public sealed class DeviceLoginRepository(V2DataSource dataSource) : IDeviceLoginRepository
{
    private const string Columns = "id, device_code_hash, user_code, user_id, status, expires_at, interval_seconds, consumed_at, created_at";

    // Code entry looks up only live pending logins, so a code is taken while one of them shows it.
    // ponytail: two creates racing with one random code can both land (as on legacy); a unique partial index on live pending codes if that ever matters.
    private const string InsertLoginUnlessCodeTaken = """
        INSERT INTO device_authorizations (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
        SELECT @Id, @DeviceCodeHash, @UserCode, @Status, @ExpiresAt, @IntervalSeconds, now()
        WHERE NOT EXISTS (
            SELECT FROM device_authorizations WHERE user_code = @UserCode AND status = 'pending' AND expires_at > @now)
        """;

    public async Task<bool> CreateAsync(DeviceLogin login, DateTimeOffset now, CancellationToken ct)
    {
        var args = new DynamicParameters(login);
        args.Add("now", now);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(InsertLoginUnlessCodeTaken, args, cancellationToken: ct)) > 0;
    }

    // A pending login whose deadline passed unnoticed may still show the code; the live one, if any,
    // expires last, so it is the one decided.
    private const string Decide = """
        UPDATE device_authorizations SET
            status = CASE WHEN expires_at <= @now THEN 'expired' WHEN @approvedBy IS NULL THEN 'denied' ELSE 'approved' END,
            user_id = CASE WHEN expires_at <= @now THEN NULL ELSE @approvedBy END
        WHERE id = (
            SELECT id FROM device_authorizations
            WHERE user_code = @userCode AND status = 'pending'
            ORDER BY expires_at DESC
            LIMIT 1
            FOR UPDATE)
        RETURNING status
        """;

    public async Task<string?> DecideAsync(string userCode, Guid? approvedBy, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(Decide, new { userCode, approvedBy, now }, cancellationToken: ct));
    }

    private const string SelectByDeviceCode = $"SELECT {Columns} FROM device_authorizations WHERE device_code_hash = @deviceCodeHash";

    public async Task<DeviceLogin?> GetByDeviceCodeAsync(string deviceCodeHash, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<DeviceLogin>(new CommandDefinition(SelectByDeviceCode, new { deviceCodeHash }, cancellationToken: ct));
    }

    private const string ExpirePending = "UPDATE device_authorizations SET status = 'expired' WHERE id = @loginId AND status = 'pending'";

    public async Task<bool> ExpireAsync(Guid loginId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(ExpirePending, new { loginId }, cancellationToken: ct)) > 0;
    }

    // The approver's row first, FOR SHARE: it conflicts with a password reset's lock on the user
    // (SessionTokenRepository), so a reset either commits first (and has expired the approval) or
    // waits for this commit (and then sees the session to delete).
    private const string LockApprover = """
        SELECT FROM users
        WHERE id = (SELECT user_id FROM device_authorizations WHERE id = @loginId AND status = 'approved')
        FOR SHARE
        """;

    private const string RedeemApproved = """
        WITH redeemed AS (
            UPDATE device_authorizations SET status = 'expired', consumed_at = now()
            WHERE id = @loginId AND status = 'approved' AND expires_at > @now
            RETURNING user_id)
        INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        SELECT gen_random_uuid(), user_id, @tokenHash, @sessionExpiresAt, now() FROM redeemed
        RETURNING user_id
        """;

    public async Task<Guid?> RedeemAsync(Guid loginId, string tokenHash, DateTimeOffset sessionExpiresAt, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(LockApprover, new { loginId }, tx, cancellationToken: ct));
        var userId = await conn.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(
            RedeemApproved, new { loginId, tokenHash, sessionExpiresAt, now }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return userId;
    }

    private const string DeleteExpired = "DELETE FROM device_authorizations WHERE expires_at < @expiredBefore";

    public async Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteExpired, new { expiredBefore }, cancellationToken: ct));
    }
}
