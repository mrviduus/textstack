namespace Domain.Identity;

/// <summary>
/// An account (V2 table <c>users</c>, ADR-031): a reader, a guest (ADR-014) or an admin
/// (<see cref="Role"/>). Deleting it deletes everything it owns (rule 9). Named apart from the legacy
/// <c>Domain.Entities.User</c>, so the code bridging both compiles without aliases.
/// </summary>
public class UserAccount
{
    public const string ReaderRole = "reader";
    public const string AdminRole = "admin";

    public Guid Id { get; set; }

    /// <summary>Unique case-insensitively (<c>ix_users_email</c>); a guest's is a generated placeholder.</summary>
    public string Email { get; set; } = "";

    public string? GoogleSubject { get; set; }
    public string? AppleSubject { get; set; }
    public string? PasswordHash { get; set; }
    public string? Name { get; set; }
    public string? Picture { get; set; }
    public bool IsGuest { get; set; }
    public DateTimeOffset? LastActiveAt { get; set; }
    public string? NativeLanguage { get; set; }
    public long StorageUsedBytes { get; set; }
    public long? StorageLimitOverrideBytes { get; set; }

    /// <summary><c>Guest</c>, <c>Free</c>, <c>Supporter</c> or <c>Staff</c>.</summary>
    public string Tier { get; set; } = "Free";

    /// <summary><see cref="ReaderRole"/> or <see cref="AdminRole"/>: an admin is an account with the admin role.</summary>
    public string Role { get; set; } = ReaderRole;

    /// <summary>When a guest became an account in place; null otherwise.</summary>
    public DateTimeOffset? PromotedAt { get; set; }

    /// <summary>Set by the server on create; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}
