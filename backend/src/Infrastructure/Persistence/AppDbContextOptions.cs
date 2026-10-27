using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// The provider setup every <see cref="AppDbContext"/> is built with — Api, Worker and the tests
/// that inspect the model — so all of them see the same model: Npgsql + pgvector + snake_case names.
/// </summary>
public static class AppDbContextOptions
{
    public static DbContextOptionsBuilder UseTextStackNpgsql(this DbContextOptionsBuilder options, string connectionString) =>
        options.UseNpgsql(connectionString, o => o.UseVector()).UseSnakeCaseNamingConvention();

    /// <summary>Options for a context built by hand, outside DI (tests).</summary>
    public static DbContextOptions<AppDbContext> For(string connectionString)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>();
        options.UseTextStackNpgsql(connectionString);
        return options.Options;
    }
}
