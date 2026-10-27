using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Application.Common;

/// <summary>
/// Postgres constraint failures behind a <see cref="DbUpdateException"/>. Matched on the SQLSTATE
/// rather than the message so they survive locale and constraint renames.
/// </summary>
public static class DbUpdateExceptionExtensions
{
    /// <summary>SQLSTATE 23505: a unique index refused the row.</summary>
    public static bool IsUniqueViolation(this DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation };

    /// <summary>SQLSTATE 23503: the referenced row does not exist (or was deleted mid-request).</summary>
    public static bool IsForeignKeyViolation(this DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation };
}
