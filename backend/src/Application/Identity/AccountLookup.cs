using Domain.Identity;

namespace Application.Identity;

/// <summary>Identity's public port for the other features (ADR-034 rule 4): who an account is (e.g. its tier, for a quota).</summary>
public interface IAccountLookup
{
    /// <inheritdoc cref="IUserRepository.GetAsync"/>
    Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct);
}

/// <summary><see cref="IAccountLookup"/> over the user repository; it delegates, it adds no SQL.</summary>
public sealed class AccountLookup(IUserRepository users) : IAccountLookup
{
    public Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct) => users.GetAsync(userId, ct);
}
