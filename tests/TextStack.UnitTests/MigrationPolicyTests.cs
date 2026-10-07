using Api.Extensions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.Internal;

namespace TextStack.UnitTests;

/// <summary>
/// The migrator owns the schema (ADR-021). If the Api migrated under Docker, a MIGRATE_TARGET
/// rollback would be undone by the next Api restart — so the only "yes" is Development + the flag.
/// </summary>
public class MigrationPolicyTests
{
    private static IHostEnvironment Env(string name) => new HostingEnvironment { EnvironmentName = name };

    private static IConfiguration Config(string? flag) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [MigrationPolicy.MigrateOnStartupKey] = flag })
            .Build();

    [Fact]
    public void ShouldMigrateOnStartup_DevelopmentWithFlag_ReturnsTrue() =>
        Assert.True(MigrationPolicy.ShouldMigrateOnStartup(Env(Environments.Development), Config("true")));

    [Theory]
    [InlineData(null)]
    [InlineData("false")]
    public void ShouldMigrateOnStartup_DevelopmentWithoutFlag_ReturnsFalse(string? flag) =>
        Assert.False(MigrationPolicy.ShouldMigrateOnStartup(Env(Environments.Development), Config(flag)));

    // The flag alone must never turn startup migrations back on outside Development:
    // CI runs the stack as Development but never sets the flag; production never sets either.
    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("Test")]
    public void ShouldMigrateOnStartup_NonDevelopmentWithFlag_ReturnsFalse(string environment) =>
        Assert.False(MigrationPolicy.ShouldMigrateOnStartup(Env(environment), Config("true")));
}
