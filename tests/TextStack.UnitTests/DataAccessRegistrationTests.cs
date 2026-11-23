using Application.Annotations;
using Application.Common;
using Application.Common.Interfaces;
using Application.Discussion;
using Application.Identity;
using Application.Library;
using Application.AdminSettings;
using Application.Reading;
using Application.Transitional;
using Application.Vocabulary;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TextStack.UnitTests;

/// <summary>The V2 side of <see cref="DataSource.AddTextStackDataAccess"/> touches nothing until used (data-access.md rule 5).</summary>
public class DataAccessRegistrationTests
{
    [Fact]
    public async Task AddTextStackDataAccess_NoV2ConnectionString_ResolvesAndTheFirstOpenNamesTheMissingKey()
    {
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess(null)
            .BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true });

        Type[] v2Ports = [typeof(IUnitOfWork), typeof(ILibraryRepository), typeof(IBookAccess), typeof(IReadingStateRepository), typeof(IReadingSessionRepository),
            typeof(IAnnotationRepository), typeof(IVocabularyRepository),
            typeof(ISharedChapterRepository), typeof(ICheckpointRepository),
            typeof(IBookInsightRepository), typeof(IReviewQuestionRepository),
            typeof(UserRepository), typeof(IAccountMergeRepository), typeof(LlmTraceWriter), typeof(AgentRunWriter),
            typeof(IAdminSettingsRepository), typeof(IBookChapterRepository), typeof(IIngestionJobRepository)];
        foreach (var port in v2Ports)
            Assert.NotNull(services.GetRequiredService(port));
        var open = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            services.GetRequiredService<AppDataSource>().OpenConnectionAsync(TestContext.Current.CancellationToken).AsTask());
        Assert.Contains("ConnectionStrings:Default", open.Message);
    }

    [Fact]
    public async Task AddTextStackDataAccess_UnreachableV2Database_ResolvesWithoutConnecting()
    {
        // Port 1: nothing listens there, so any connection attempt would throw.
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess("Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=1")
            .BuildServiceProvider();

        Assert.NotNull(services.GetService<ILibraryRepository>());
        Assert.NotNull(services.GetService<IUnitOfWork>());
        Assert.NotNull(services.GetService<IReadingStateRepository>());
        Assert.NotNull(services.GetService<IReadingSessionRepository>());
        Assert.NotNull(services.GetService<IAnnotationRepository>());
        Assert.NotNull(services.GetService<IVocabularyRepository>());
        Assert.NotNull(services.GetService<ISharedChapterRepository>());
        Assert.NotNull(services.GetService<ICheckpointRepository>());
        Assert.NotNull(services.GetService<IBookInsightRepository>());
        Assert.NotNull(services.GetService<IReviewQuestionRepository>());
        Assert.NotNull(services.GetService<UserRepository>());
        Assert.NotNull(services.GetService<IAccountMergeRepository>());
        Assert.NotNull(services.GetService<LlmTraceWriter>());
        Assert.NotNull(services.GetService<AgentRunWriter>());
        Assert.NotNull(services.GetService<IAdminSettingsRepository>());
        Assert.NotNull(services.GetService<IBookChapterRepository>());
        Assert.NotNull(services.GetService<IIngestionJobRepository>());
    }

    [Theory]
    [InlineData("new", "old", "new")]
    [InlineData(null, "old", null)] // the old key is no longer read
    [InlineData(null, null, null)]
    public void AppConnectionString_OnlyDefault_OldKeyIgnored(string? fresh, string? old, string? expected)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["ConnectionStrings:Default"] = fresh, ["ConnectionStrings:V2"] = old })
            .Build();

        Assert.Equal(expected, config.AppConnectionString());
    }
}
