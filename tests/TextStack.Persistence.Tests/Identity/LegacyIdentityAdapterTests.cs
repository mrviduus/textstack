using Domain.Identity;
using Infrastructure.Persistence.Legacy;
using Microsoft.EntityFrameworkCore;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

// The identity ports' contracts on the legacy schema, through the EF adapters production binds until
// M5.1 (#1100). One EF context per test, as one request or one worker run has.

public class EfMcpKeyRepositoryTests(PostgresFixture db) : McpKeyRepositoryContract(db, new EfMcpKeyRepository(db.NewDbContext()));

public class EfOAuthRepositoryTests(PostgresFixture db) : OAuthRepositoryContract(db, new EfOAuthRepository(db.NewDbContext()));

public class EfUserRepositoryTests(PostgresFixture db) : UserRepositoryContract(db, new EfUserRepository(db.NewDbContext()))
{
    [Fact]
    public async Task UpdateNameAndLanguageAsync_RowTrackedBefore_ReturnsTheUpdateNotTheTrackedCopy()
    {
        // ProfileEndpoints reads the user through AuthService first, into the same request's context.
        var context = db.NewDbContext();
        var user = await db.NewReaderAsync();
        await context.Users.SingleAsync(u => u.Id == user, Ct);

        var updated = await new EfUserRepository(context).UpdateNameAndLanguageAsync(user, "Ann", "uk", Ct);

        Assert.Equal(("Ann", "uk"), (updated!.Name, updated.NativeLanguage));
    }
}

public class EfSessionTokenRepositoryTests(PostgresFixture db) : SessionTokenRepositoryContract(db, new EfSessionTokenRepository(db.NewDbContext()))
{
    protected override Task SeedSessionAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt) =>
        db.ExecAsync("INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (gen_random_uuid(), @userId, @tokenHash, @expiresAt, now())",
            new { userId, tokenHash, expiresAt });

    protected override Task SeedPasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt) =>
        db.ExecAsync("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at, used) VALUES (gen_random_uuid(), @userId, @tokenHash, @expiresAt, now(), false)",
            new { userId, tokenHash, expiresAt });

    [Fact]
    public async Task DeleteExpiredSessionsAsync_AdminSessions_SweptLikeReaders()
    {
        // Legacy keeps admin sessions in their own table; V2's one table holds both kinds.
        var admin = Guid.NewGuid();
        var cutoff = new DateTimeOffset(2000, 1, 2, 0, 0, 0, TimeSpan.Zero);
        await db.ExecAsync("""
            INSERT INTO admin_users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (@admin, @email, 'x', 0, true, now(), now());
            INSERT INTO admin_refresh_tokens (id, admin_user_id, token_hash, expires_at, created_at) VALUES
                (gen_random_uuid(), @admin, @expired, @before, now()), (gen_random_uuid(), @admin, @live, @cutoff, now());
            """, new { admin, email = $"{admin}@admin.test", expired = NewHash(), live = NewHash(), before = cutoff.AddDays(-1), cutoff });

        Assert.Equal(1, await new EfSessionTokenRepository(db.NewDbContext()).DeleteExpiredSessionsAsync(cutoff, Ct));

        Assert.Equal(1L, await db.ScalarAsync<long>("SELECT count(*) FROM admin_refresh_tokens WHERE admin_user_id = @admin", new { admin }));
    }
}

public class EfDeviceLoginRepositoryTests(PostgresFixture db) : DeviceLoginRepositoryContract(db, new EfDeviceLoginRepository(db.NewDbContext()))
{
    protected override Task SeedAsync(DeviceLogin login) =>
        db.ExecAsync("""
            INSERT INTO device_authorizations (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
            VALUES (@Id, @DeviceCodeHash, @UserCode, @Status, @ExpiresAt, @IntervalSeconds, now())
            """, login);
}
