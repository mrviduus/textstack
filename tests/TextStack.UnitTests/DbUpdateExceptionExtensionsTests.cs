using Application.Common;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace TextStack.UnitTests;

/// <summary>
/// Recovery paths (lost insert races, a book deleted mid-request) must trigger on their own SQLSTATE
/// and nothing else — matched on SQLSTATE so they survive locale changes and constraint renames.
/// </summary>
public class DbUpdateExceptionExtensionsTests
{
    private static DbUpdateException Postgres(string sqlState) =>
        new("save failed", new PostgresException("constraint failed", "ERROR", "ERROR", sqlState));

    [Fact]
    public void IsUniqueViolation_UniqueViolation_True() =>
        Assert.True(Postgres(PostgresErrorCodes.UniqueViolation).IsUniqueViolation());

    [Fact]
    public void IsUniqueViolation_ForeignKeyViolation_False() =>
        Assert.False(Postgres(PostgresErrorCodes.ForeignKeyViolation).IsUniqueViolation());

    [Fact]
    public void IsForeignKeyViolation_ForeignKeyViolation_True() =>
        Assert.True(Postgres(PostgresErrorCodes.ForeignKeyViolation).IsForeignKeyViolation());

    [Fact]
    public void IsForeignKeyViolation_UniqueViolation_False() =>
        Assert.False(Postgres(PostgresErrorCodes.UniqueViolation).IsForeignKeyViolation());

    [Fact]
    public void NonPostgresInner_NeitherViolation()
    {
        var ex = new DbUpdateException("save failed", new InvalidOperationException("boom"));

        Assert.False(ex.IsUniqueViolation());
        Assert.False(ex.IsForeignKeyViolation());
    }
}
