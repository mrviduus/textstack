namespace Api.Extensions;

/// <summary>
/// The `migrator` compose service owns the schema (ADR-021). The Api never migrates under Docker:
/// doing so undid a <c>MIGRATE_TARGET</c> rollback on the next Api restart. The one exception is
/// <c>dotnet run</c> without Docker, where launchSettings.json sets
/// <c>Database__MigrateOnStartup=true</c> — and even that is honoured only in Development, so a
/// stray flag in a production environment cannot turn it back on.
/// </summary>
internal static class MigrationPolicy
{
    public const string MigrateOnStartupKey = "Database:MigrateOnStartup";

    public static bool ShouldMigrateOnStartup(IHostEnvironment env, IConfiguration config) =>
        env.IsDevelopment() && config.GetValue<bool>(MigrateOnStartupKey);
}
