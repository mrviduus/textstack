using Application.Annotations;
using Application.Common.Interfaces;
using Application.Discussion;
using Application.Library;
using Application.Reading;
using Application.Vocabulary;
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

        Type[] v2Ports = [typeof(ILibraryRepository), typeof(IAnnotationRepository), typeof(IVocabularyRepository),
            typeof(ISharedChapterRepository), typeof(ICheckpointRepository),
            typeof(IBookInsightRepository), typeof(IReviewQuestionRepository)];
        foreach (var port in v2Ports)
            Assert.Contains("ConnectionStrings:V2", Assert.Throws<InvalidOperationException>(() => services.GetRequiredService(port)).Message);
        // The legacy insight port of the same name does not need V2.
        Assert.NotNull(services.GetRequiredService<IInsightRepository>());
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
        Assert.NotNull(services.GetService<IAnnotationRepository>());
        Assert.NotNull(services.GetService<IVocabularyRepository>());
        Assert.NotNull(services.GetService<ISharedChapterRepository>());
        Assert.NotNull(services.GetService<ICheckpointRepository>());
        Assert.NotNull(services.GetService<IBookInsightRepository>());
        Assert.NotNull(services.GetService<IReviewQuestionRepository>());
    }
}
