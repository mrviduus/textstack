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

    private const string InsertLogin = """
        INSERT INTO device_authorizations (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
        VALUES (@Id, @DeviceCodeHash, @UserCode, @Status, @ExpiresAt, @IntervalSeconds, now())
        """;

    public async Task CreateAsync(DeviceLogin login, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertLogin, login, cancellationToken: ct));
    }

    private const string PendingUserCodeTaken = """
        SELECT EXISTS (SELECT FROM device_authorizations WHERE user_code = @userCode AND status = 'pending' AND expires_at > @now)
        """;

    public async Task<bool> PendingUserCodeExistsAsync(string userCode, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<bool>(new CommandDefinition(PendingUserCodeTaken, new { userCode, now }, cancellationToken: ct));
    }

    // A pending login whose deadline passed unnoticed may still show the code; the live one, if any,
    // expires last, so it is the one decided.
    private const string Decide = """
        WITH target AS (
            SELECT id FROM device_authorizations
            WHERE user_code = @userCode AND status = 'pending'
            ORDER BY expires_at DESC
            LIMIT 1
            FOR UPDATE)
        UPDATE device_authorizations d SET
            status = CASE WHEN d.expires_at <= @now THEN 'expired' WHEN @approvedBy IS NULL THEN 'denied' ELSE 'approved' END,
            user_id = CASE WHEN d.expires_at <= @now THEN NULL ELSE @approvedBy END
        FROM target
        WHERE d.id = target.id
        RETURNING d.status
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

    private const string RedeemApproved = """
        UPDATE device_authorizations SET status = 'expired', consumed_at = @now
        WHERE id = @loginId AND status = 'approved' AND expires_at > @now
        RETURNING user_id
        """;

    public async Task<Guid?> RedeemAsync(Guid loginId, DateTimeOffset now, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<Guid?>(new CommandDefinition(RedeemApproved, new { loginId, now }, cancellationToken: ct));
    }

    private const string DeleteExpired = "DELETE FROM device_authorizations WHERE expires_at < @expiredBefore";

    public async Task<int> DeleteExpiredAsync(DateTimeOffset expiredBefore, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteExpired, new { expiredBefore }, cancellationToken: ct));
    }
}
