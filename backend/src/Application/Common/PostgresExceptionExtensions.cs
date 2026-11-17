using Npgsql;

namespace Application.Common;

/// <summary>
/// Postgres constraint failures, matched on the SQLSTATE rather than the message so they survive
/// locale and constraint renames.
/// </summary>
/// <remarks>Both shapes are checked: the bare <see cref="PostgresException"/>, and one wrapped as an inner exception.</remarks>
public static class PostgresExceptionExtensions
{
    /// <summary>SQLSTATE 23505: a unique index refused the row.</summary>
    public static bool IsUniqueViolation(this Exception ex) =>
        SqlState(ex) == PostgresErrorCodes.UniqueViolation;

    /// <summary>SQLSTATE 23503: the referenced row does not exist (or was deleted mid-request).</summary>
    public static bool IsForeignKeyViolation(this Exception ex) =>
        SqlState(ex) == PostgresErrorCodes.ForeignKeyViolation;

    /// <summary>
    /// SQLSTATE class 23 — unique, foreign-key, check, not-null. Deterministic: the offending row is
    /// still there on the next attempt.
    /// </summary>
    public static bool IsIntegrityViolation(this Exception ex) =>
        SqlState(ex)?.StartsWith("23", StringComparison.Ordinal) == true;

    /// <summary>
    /// SQLSTATE 40P01 or 40001: a deadlock or a serialization failure. Not deterministic: the same
    /// work on a fresh snapshot may succeed.
    /// </summary>
    public static bool IsTransientConflict(this Exception ex) =>
        SqlState(ex) is PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure;

    private static string? SqlState(Exception ex) =>
        (ex as PostgresException ?? ex.InnerException as PostgresException)?.SqlState;
}
