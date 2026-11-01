using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 accounts (table <c>users</c>, ADR-031): readers, guests (ADR-014) and admins, who are
/// accounts with the admin role (there is no "inactive admin": an admin that is not active does not
/// exist). A method that names a user changes only that row (docs/01-architecture/data-access.md rule 7).
/// The guest→account merge is not here: it moves every aggregate (M2.5, plan §6.1).
/// </summary>
public interface IUserRepository
{
    /// <summary>The account; null when there is none.</summary>
    Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct);

    /// <summary>The account with this email, compared case-insensitively; null when there is none.</summary>
    Task<UserAccount?> GetByEmailAsync(string email, CancellationToken ct);

    Task<UserAccount?> GetByGoogleSubjectAsync(string googleSubject, CancellationToken ct);

    Task<UserAccount?> GetByAppleSubjectAsync(string appleSubject, CancellationToken ct);

    /// <summary>Whether any account (a guest's included) holds this email, compared case-insensitively.</summary>
    Task<bool> EmailExistsAsync(string email, CancellationToken ct);

    /// <summary>
    /// Creates <paramref name="account"/> (a guest, a reader or an admin, as its fields say) and returns
    /// it as stored. Null when its id, its email or one of its sign-in subjects is already taken: a
    /// concurrent sign-in won, and the caller reads that account instead.
    /// </summary>
    Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct);

    /// <summary>What a provider sign-in refreshes on an existing account. False when there is no such account.</summary>
    Task<bool> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct);

    /// <summary>
    /// Turns a guest into an account in place: email, name and password set, <c>promoted_at</c> stamped,
    /// everything it owns kept. Null when <paramref name="userId"/> is not a guest.
    /// </summary>
    Task<UserAccount?> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct);

    /// <summary>Clears the guest flag of an account that already signed in as itself. False when it was not a guest.</summary>
    Task<bool> ClearGuestFlagAsync(Guid userId, CancellationToken ct);

    /// <summary>Sets <see cref="UserAccount.Role"/> (a value outside the CHECK is a caller bug). False when there is no such account.</summary>
    Task<bool> SetRoleAsync(Guid userId, string role, CancellationToken ct);

    /// <summary>
    /// Deletes the account and, by the schema's cascades, every row it owns (ADR-031 rule 9); its LLM
    /// traces stay, they have no FK by design. False when there was no such account.
    /// </summary>
    Task<bool> DeleteAsync(Guid userId, CancellationToken ct);
}
