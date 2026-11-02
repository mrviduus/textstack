using Domain.Identity;

namespace Application.Identity;

/// <summary>
/// The V2 accounts (table <c>users</c>, ADR-031): readers, guests (ADR-014) and admins, who are
/// accounts with the admin role (there is no "inactive admin": an admin that is not active does not
/// exist). A method that names a user changes only that row (docs/01-architecture/data-access.md rule 7).
/// <para>Emails are stored as given: the caller normalises them (legacy AuthService trims and
/// lower-cases). <c>ix_users_email</c> makes lookups and uniqueness case-insensitive, not
/// whitespace-tolerant.</para>
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

    /// <summary>
    /// Creates <paramref name="account"/> (a guest, a reader or an admin, as its fields say) and returns
    /// it as stored. Null when its id, its email or one of its sign-in subjects is already taken: a
    /// concurrent sign-in won, and the caller reads that account instead.
    /// </summary>
    Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct);

    /// <summary>
    /// What a provider sign-in refreshes on an existing account; returns it updated.
    /// <see cref="AccountUpdateOutcome.NotFound"/> when there is no such account,
    /// <see cref="AccountUpdateOutcome.EmailTaken"/> when another account holds the email (nothing changed).
    /// </summary>
    Task<AccountUpdate> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct);

    /// <summary>
    /// Turns a guest into an account in place: email, name and password set, <c>promoted_at</c> stamped,
    /// everything it owns kept. <see cref="AccountUpdateOutcome.NotFound"/> when <paramref name="userId"/>
    /// is not a guest, <see cref="AccountUpdateOutcome.EmailTaken"/> when another account holds the email.
    /// </summary>
    Task<AccountUpdate> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct);

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

/// <summary>What became of an update that sets an account's email.</summary>
public enum AccountUpdateOutcome
{
    Updated,

    /// <summary>No account (or, for a promotion, no guest) under that id: nothing changed.</summary>
    NotFound,

    /// <summary>Another account holds the email, compared case-insensitively: nothing changed.</summary>
    EmailTaken,
}

/// <summary>The account as stored after the update; null unless <see cref="AccountUpdateOutcome.Updated"/>.</summary>
public sealed record AccountUpdate(AccountUpdateOutcome Outcome, UserAccount? Account);
