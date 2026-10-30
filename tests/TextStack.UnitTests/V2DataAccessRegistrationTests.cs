using Application.Discussion;
using Application.Library;
using Application.Reading;
using Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace TextStack.UnitTests;

/// <summary>The V2 side of <see cref="DataSource.AddTextStackDataAccess"/> touches nothing until used (data-access.md rule 5).</summary>
public class V2DataAccessRegistrationTests
{
    private const string Legacy = "Host=localhost;Database=legacy";

    [Fact]
    public async Task AddTextStackDataAccess_NoV2ConnectionString_BuildsButResolvingNamesTheMissingKey()
    {
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess(Legacy, null)
            .BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true });

        var error = Assert.Throws<InvalidOperationException>(() => services.GetRequiredService<ILibraryRepository>());
        Assert.Contains("ConnectionStrings:V2", error.Message);
    }

    [Fact]
    public async Task AddTextStackDataAccess_UnreachableV2Database_ResolvesWithoutConnecting()
    {
        // Port 1: nothing listens there, so any connection attempt would throw.
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess(Legacy, "Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=1")
            .BuildServiceProvider();

        Assert.NotNull(services.GetService<ILibraryRepository>());
        Assert.NotNull(services.GetService<IReadingStateRepository>());
        Assert.NotNull(services.GetService<ISharedChapterRepository>());
        Assert.NotNull(services.GetService<ICheckpointRepository>());
        Assert.NotNull(services.GetService<IInsightRepository>());
        Assert.NotNull(services.GetService<IReviewQuestionRepository>());
    }
}
