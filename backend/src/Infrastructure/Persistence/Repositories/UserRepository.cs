using Application.Common;
using Application.Identity;
using Dapper;
using Domain.Identity;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IUserRepository"/> on <c>textstack_v2</c>. Uniqueness lives in
/// the schema (database/v2/migrations/0000_baseline.up.sql, "Identity"): one account per
/// <c>lower(email)</c>, per Google subject and per Apple subject.
/// </summary>
public sealed class UserRepository(V2DataSource dataSource) : IUserRepository
{
    private const string Columns =
        "id, email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language, storage_used_bytes, storage_limit_override_bytes, tier, role, promoted_at, created_at";

    private const string SelectById = $"SELECT {Columns} FROM users WHERE id = @userId";

    public async Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(SelectById, new { userId }, cancellationToken: ct));
    }

    // lower(email) on both sides: the expression ix_users_email indexes.
    private const string SelectByEmail = $"SELECT {Columns} FROM users WHERE lower(email) = lower(@email)";

    public async Task<UserAccount?> GetByEmailAsync(string email, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(SelectByEmail, new { email }, cancellationToken: ct));
    }

    private const string SelectByGoogleSubject = $"SELECT {Columns} FROM users WHERE google_subject = @googleSubject";

    public async Task<UserAccount?> GetByGoogleSubjectAsync(string googleSubject, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(SelectByGoogleSubject, new { googleSubject }, cancellationToken: ct));
    }

    private const string SelectByAppleSubject = $"SELECT {Columns} FROM users WHERE apple_subject = @appleSubject";

    public async Task<UserAccount?> GetByAppleSubjectAsync(string appleSubject, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(SelectByAppleSubject, new { appleSubject }, cancellationToken: ct));
    }

    // No arbiter: the id, the email and both subjects are unique, and any of them taken means "no row".
    private const string InsertAccount = $"""
        INSERT INTO users (id, email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language, tier, role, created_at)
        VALUES (@Id, @Email, @GoogleSubject, @AppleSubject, @PasswordHash, @Name, @Picture, @IsGuest, @LastActiveAt, @NativeLanguage, @Tier, @Role, now())
        ON CONFLICT DO NOTHING
        RETURNING {Columns}
        """;

    public async Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(InsertAccount, account, cancellationToken: ct));
    }

    private const string UpdateProfile = $"""
        UPDATE users SET email = @email, name = @name, picture = @picture WHERE id = @userId
        RETURNING {Columns}
        """;

    public Task<AccountUpdate> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct) =>
        UpdateEmailHolderAsync(UpdateProfile, new { userId, email, name, picture }, ct);

    private const string PromoteGuest = $"""
        UPDATE users SET email = @email, name = @name, password_hash = @passwordHash, is_guest = false, promoted_at = now()
        WHERE id = @userId AND is_guest
        RETURNING {Columns}
        """;

    public Task<AccountUpdate> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct) =>
        UpdateEmailHolderAsync(PromoteGuest, new { userId, email, name, passwordHash }, ct);

    /// <summary>Runs an UPDATE … RETURNING that sets <c>email</c>: no row is <see cref="AccountUpdateOutcome.NotFound"/>.</summary>
    private async Task<AccountUpdate> UpdateEmailHolderAsync(string sql, object args, CancellationToken ct)
    {
        try
        {
            await using var conn = await dataSource.OpenConnectionAsync(ct);
            var account = await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(sql, args, cancellationToken: ct));
            return new(account is null ? AccountUpdateOutcome.NotFound : AccountUpdateOutcome.Updated, account);
        }
        // Another account holds the email: reachable (a provider changed it, a guest registers with
        // it), so a result, not an exception. UPDATE has no ON CONFLICT to turn it into "no row".
        catch (PostgresException e) when (e.IsUniqueViolation() && e.ConstraintName == "ix_users_email")
        {
            return new(AccountUpdateOutcome.EmailTaken, null);
        }
    }

    private const string UpdateRole = "UPDATE users SET role = @role WHERE id = @userId";

    public async Task<bool> SetRoleAsync(Guid userId, string role, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(UpdateRole, new { userId, role }, cancellationToken: ct)) > 0;
    }

    // Every user-owned table cascades from users; the deferred provenance FKs are checked when this
    // statement's own transaction commits.
    private const string DeleteAccount = "DELETE FROM users WHERE id = @userId";

    public async Task<bool> DeleteAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteAccount, new { userId }, cancellationToken: ct)) > 0;
    }
}
