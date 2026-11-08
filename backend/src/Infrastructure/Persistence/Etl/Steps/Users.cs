using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// legacy <c>users</c> + <c>admin_users</c> → V2 <c>users</c> (ADR-031 rows 22 and 24, decided item 7; #1094).
/// Conflict rule (runbook "Conflict rules"): a controlled upsert by id. Every column is filled from
/// legacy, so M2.2's shadow rows (id, email, guest flag) are completed, never counted as drift; V2's
/// <c>admin</c> role is kept; <c>credentials_reset_at</c> is V2's own and never touched. An email V2 holds
/// under another id is a conflict: reported, the run fails, nothing is overwritten. V2 users with no
/// legacy row are cleanup candidates, never deleted by a run.
/// </summary>
public static class EtlV2Users
{
    public static readonly EtlV2Step Step = new("users", ["users", "admin_users"], ["users"], RunAsync);

    private const string Columns =
        "id, email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language, storage_used_bytes, storage_limit_override_bytes, tier, promoted_at, role, created_at";

    // Legacy's unused '' default for google_subject is no subject: two of them would collide on V2's unique index.
    private const string SelectLegacyUsers = """
        SELECT id, email, NULLIF(google_subject, '') AS google_subject, apple_subject, password_hash, name, picture, is_guest,
               last_active_at, native_language, storage_used_bytes, storage_limit_override_bytes, tier, promoted_at, 'reader' AS role, created_at
        FROM users
        ORDER BY id
        """;

    private const string SelectAdmins = "SELECT id, email, password_hash, is_active, created_at FROM admin_users ORDER BY id";

    private const string SelectV2Users = $"SELECT {Columns} FROM users";

    // Case folding by V2's own lower(), the one ix_users_email indexes: .NET's ToLowerInvariant disagrees on
    // some non-ASCII letters ('İ'), and a preflight that folds otherwise passes what the insert then aborts on.
    private const string FoldEmails = "SELECT e AS email, lower(e) AS folded FROM unnest(@emails) AS e";

    private const string InsertUser = """
        INSERT INTO users (id, email, google_subject, apple_subject, password_hash, name, picture, is_guest, last_active_at, native_language,
                           storage_used_bytes, storage_limit_override_bytes, tier, promoted_at, role, created_at)
        VALUES (@Id, @Email, @GoogleSubject, @AppleSubject, @PasswordHash, @Name, @Picture, @IsGuest, @LastActiveAt, @NativeLanguage,
                @StorageUsedBytes, @StorageLimitOverrideBytes, @Tier, @PromotedAt, @Role, @CreatedAt)
        """;

    private const string UpdateUser = """
        UPDATE users SET email = @Email, google_subject = @GoogleSubject, apple_subject = @AppleSubject, password_hash = @PasswordHash,
                         name = @Name, picture = @Picture, is_guest = @IsGuest, last_active_at = @LastActiveAt, native_language = @NativeLanguage,
                         storage_used_bytes = @StorageUsedBytes, storage_limit_override_bytes = @StorageLimitOverrideBytes, tier = @Tier,
                         promoted_at = @PromotedAt, role = @Role, created_at = @CreatedAt
        WHERE id = @Id
        """;

    private static readonly string[] Tiers = ["Guest", "Free", "Supporter", "Staff"];

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var legacy = await EtlV2Rows.SourceAsync<UserRow>(context, SelectLegacyUsers, null, ct);
        var admins = await EtlV2Rows.SourceAsync<AdminRow>(context, SelectAdmins, null, ct);
        var v2 = (await EtlV2Rows.TargetAsync<UserRow>(context, SelectV2Users, null, ct)).ToDictionary(u => u.Id);

        string[] emails = [.. legacy.Select(u => u.Email).Concat(admins.Select(a => a.Email)).Concat(v2.Values.Select(u => u.Email)).Distinct()];
        var folded = (await EtlV2Rows.TargetAsync<FoldedEmail>(context, FoldEmails, new { emails }, ct)).ToDictionary(f => f.Email, f => f.Folded);
        string Fold(string email) => folded[email];

        var expected = legacy.ToDictionary(u => u.Id);
        var byEmail = legacy.ToLookup(u => Fold(u.Email));
        // An inactive admin is not promoted, and not decided either: refused, never guessed (ADR-031 item 7 covers active ones).
        EtlV2Rows.Check(context, "users: inactive admin_users row (no rule decided)", admins.Where(a => !a.IsActive).Select(a => a.Id.ToString()));
        var adminIdTaken = new List<string>();
        foreach (var admin in admins.Where(a => a.IsActive))
        {
            var matched = byEmail[Fold(admin.Email)].ToList();
            if (matched.Count > 0)
                matched.ForEach(u => expected[u.Id] = expected[u.Id] with { Role = "admin" });
            else if (expected.ContainsKey(admin.Id))
                adminIdTaken.Add(admin.Id.ToString());
            else
                expected[admin.Id] = new UserRow { Id = admin.Id, Email = admin.Email, PasswordHash = admin.PasswordHash, Role = "admin", CreatedAt = admin.CreatedAt };
        }
        EtlV2Rows.Check(context, "users: admin_users id held by a user of another email", adminIdTaken);
        // No merge rule is decided for them (#1027): the second of a pair would abort on V2's lower(email) index.
        // Over every row to write, so two admins with no user (admin_users.email is unique only case-sensitively) count too.
        EtlV2Rows.Check(context, "users: legacy emails equal but for case", expected.Values.GroupBy(u => Fold(u.Email))
            .Where(g => g.Count() > 1).Select(g => string.Join("/", g.Select(u => u.Id))));
        // V2's partial unique indexes on the subjects (exact, no folding): the second of a pair would abort the insert.
        foreach (var (column, subject) in new (string, Func<UserRow, string?>)[] { ("google_subject", u => u.GoogleSubject), ("apple_subject", u => u.AppleSubject) })
            EtlV2Rows.Check(context, $"users: {column} duplicated in legacy", expected.Values.Where(u => subject(u) is not null).GroupBy(subject)
                .Where(g => g.Count() > 1).Select(g => string.Join("/", g.Select(u => u.Id))));
        foreach (var (id, row) in expected)
            if (v2.TryGetValue(id, out var current) && current.Role == "admin")
                expected[id] = row with { Role = "admin" };
        EtlV2Rows.Check(context, "users: tier outside V2's set", expected.Values.Where(u => !Tiers.Contains(u.Tier)).Select(u => u.Id.ToString()));
        HeldByAnother(context, "email", expected.Values, v2.Values, u => Fold(u.Email));
        // V2's partial unique indexes on the subjects (exact, no folding): a raw 23505 otherwise.
        HeldByAnother(context, "google_subject", expected.Values, v2.Values, u => u.GoogleSubject);
        HeldByAnother(context, "apple_subject", expected.Values, v2.Values, u => u.AppleSubject);

        // Owner 2026-11-08: reported only, never deleted. Only a guest gets a ready DELETE; an account is a human's call.
        foreach (var orphan in v2.Values.Where(u => !expected.ContainsKey(u.Id)).OrderBy(u => u.Id))
            context.CleanupActions.Add(orphan.IsGuest
                ? $"users {orphan.Id}: V2 guest with no legacy row (#1094); if the identity mirror left it behind, a human deletes it "
                    + $"with its V2 rows: DELETE FROM users WHERE id = '{orphan.Id}'"
                : $"users {orphan.Id}: V2 account with no legacy row; not deleted, a human reviews it");

        var plan = EtlV2Rows.Classify(expected.Values, v2.Values, u => u.Id);
        context.Writes["users"] = new(plan.New.Count, plan.Different.Count, plan.Unchanged);
        if (!context.MayWrite)
            return;
        await using (var tx = await context.BeginWriteAsync(ct))
        {
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertUser, plan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(UpdateUser, plan.Different, tx.Transaction, cancellationToken: ct));
            await tx.CommitAsync(ct);
        }
        var after = EtlV2Rows.Classify(expected.Values, await EtlV2Rows.TargetAsync<UserRow>(context, SelectV2Users, null, ct), u => u.Id);
        EtlV2Rows.Check(context, "users: parity (every legacy user and admin is its V2 row)",
            after.New.Concat(after.Different).Select(u => u.Id.ToString()));
    }

    /// <summary>A unique value of a row to write that V2 holds under another id: "users: {column} held by another V2 id", as row/holder.</summary>
    private static void HeldByAnother(EtlV2Context context, string column, IEnumerable<UserRow> expected, IEnumerable<UserRow> v2, Func<UserRow, string?> value)
    {
        var holders = v2.Where(u => value(u) is not null).ToLookup(u => value(u)!, u => u.Id);
        EtlV2Rows.Check(context, $"users: {column} held by another V2 id", expected.Where(u => value(u) is not null).SelectMany(u =>
            holders[value(u)!].Where(holder => holder != u.Id).Select(holder => $"{u.Id}/{holder}")));
    }

    private sealed record FoldedEmail(string Email, string Folded);

    private sealed record UserRow
    {
        public Guid Id { get; init; }
        public string Email { get; init; } = "";
        public string? GoogleSubject { get; init; }
        public string? AppleSubject { get; init; }
        public string? PasswordHash { get; init; }
        public string? Name { get; init; }
        public string? Picture { get; init; }
        public bool IsGuest { get; init; }
        public DateTimeOffset? LastActiveAt { get; init; }
        public string? NativeLanguage { get; init; }
        public long StorageUsedBytes { get; init; }
        public long? StorageLimitOverrideBytes { get; init; }
        public string Tier { get; init; } = "Free";
        public DateTimeOffset? PromotedAt { get; init; }
        public string Role { get; init; } = "reader";
        public DateTimeOffset CreatedAt { get; init; }
    }

    private sealed record AdminRow
    {
        public Guid Id { get; init; }
        public string Email { get; init; } = "";
        public string PasswordHash { get; init; } = "";
        public bool IsActive { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }
}
