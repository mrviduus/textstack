namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// What an identity port's contract tests need of a database, legacy or V2 (#1100): the credential
/// tables have the same names and columns on both, so one contract runs against either.
/// </summary>
public interface IIdentityFixture
{
    /// <summary>A fresh account (a guest when <paramref name="isGuest"/>) with a unique email.</summary>
    Task<Guid> NewReaderAsync(bool isGuest = false);

    /// <summary>Runs <paramref name="sql"/> (a test's own setup, never input) in its own autocommit.</summary>
    Task ExecAsync(string sql, object args);

    Task<T> ScalarAsync<T>(string sql, object args);

    /// <summary>The user's rows in <paramref name="table"/> (a constant, never input).</summary>
    Task<long> CountAsync(string table, Guid userId, Guid? bookId = null);
}
