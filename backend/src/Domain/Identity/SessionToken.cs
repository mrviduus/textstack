namespace Domain.Identity;

/// <summary>
/// A signed-in session of a reader or an admin (V2 table <c>user_refresh_tokens</c>): the hash of its
/// refresh token, never the token. Rotation expires the row and creates its successor, which keeps
/// the spent hash in <see cref="PreviousTokenHash"/>, so a spent token presented again is recognised
/// and its whole family revoked.
/// </summary>
public class SessionToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string TokenHash { get; set; } = "";
    public string? PreviousTokenHash { get; set; }

    /// <summary>The sign-in this session was rotated from: the id of its first session.</summary>
    public Guid FamilyId { get; set; }

    /// <summary>When that sign-in happened; the absolute lifetime counts from here.</summary>
    public DateTimeOffset FamilyStartedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
