using Application.Identity;
using Dapper;
using Domain.Identity;

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

    // lower(email) on both sides: the expression ix_users_email indexes.
    private const string SelectByEmail = $"SELECT {Columns} FROM users WHERE lower(email) = lower(@email)";

    private const string SelectByGoogleSubject = $"SELECT {Columns} FROM users WHERE google_subject = @googleSubject";
    private const string SelectByAppleSubject = $"SELECT {Columns} FROM users WHERE apple_subject = @appleSubject";

    private const string EmailTaken = "SELECT EXISTS (SELECT FROM users WHERE lower(email) = lower(@email))";

    public async Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct) => await QuerySingleAsync(SelectById, new { userId }, ct);

    public async Task<UserAccount?> GetByEmailAsync(string email, CancellationToken ct) => await QuerySingleAsync(SelectByEmail, new { email }, ct);

    public async Task<UserAccount?> GetByGoogleSubjectAsync(string googleSubject, CancellationToken ct) =>
        await QuerySingleAsync(SelectByGoogleSubject, new { googleSubject }, ct);

    public async Task<UserAccount?> GetByAppleSubjectAsync(string appleSubject, CancellationToken ct) =>
        await QuerySingleAsync(SelectByAppleSubject, new { appleSubject }, ct);

    public async Task<bool> EmailExistsAsync(string email, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<bool>(new CommandDefinition(EmailTaken, new { email }, cancellationToken: ct));
    }

    // No arbiter: the id, the email and both subjects are unique, and any of them taken means "no row".
    private const string InsertAccount = $"""
        INSERT INTO users (id, email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language, tier, role, created_at)
        VALUES (@Id, @Email, @GoogleSubject, @AppleSubject, @PasswordHash, @Name, @Picture, @IsGuest, @LastActiveAt, @NativeLanguage, @Tier, @Role, now())
        ON CONFLICT DO NOTHING
        RETURNING {Columns}
        """;

    public async Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct) => await QuerySingleAsync(InsertAccount, account, ct);

    private const string UpdateProfile = "UPDATE users SET email = @email, name = @name, picture = @picture WHERE id = @userId";

    public Task<bool> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct) =>
        ExecuteAsync(UpdateProfile, new { userId, email, name, picture }, ct);

    private const string PromoteGuest = $"""
        UPDATE users SET email = @email, name = @name, password_hash = @passwordHash, is_guest = false, promoted_at = now()
        WHERE id = @userId AND is_guest
        RETURNING {Columns}
        """;

    public async Task<UserAccount?> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct) =>
        await QuerySingleAsync(PromoteGuest, new { userId, email, name, passwordHash }, ct);

    private const string ClearGuestFlag = "UPDATE users SET is_guest = false WHERE id = @userId AND is_guest";

    public Task<bool> ClearGuestFlagAsync(Guid userId, CancellationToken ct) => ExecuteAsync(ClearGuestFlag, new { userId }, ct);

    private const string UpdateRole = "UPDATE users SET role = @role WHERE id = @userId";

    public Task<bool> SetRoleAsync(Guid userId, string role, CancellationToken ct) => ExecuteAsync(UpdateRole, new { userId, role }, ct);

    // Every user-owned table cascades from users; the deferred provenance FKs are checked when this
    // statement's own transaction commits.
    private const string DeleteAccount = "DELETE FROM users WHERE id = @userId";

    public Task<bool> DeleteAsync(Guid userId, CancellationToken ct) => ExecuteAsync(DeleteAccount, new { userId }, ct);

    private async Task<UserAccount?> QuerySingleAsync(string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<UserAccount>(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    private async Task<bool> ExecuteAsync(string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: ct)) > 0;
    }
}
