using Application.Annotations;
using Application.Common;
using Application.Common.Interfaces;
using Application.Discussion;
using Application.Identity;
using Application.Library;
using Application.Ops;
using Application.Reading;
using Application.Transitional;
using Application.Vocabulary;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.DependencyInjection;

namespace TextStack.UnitTests;

/// <summary>The V2 side of <see cref="DataSource.AddTextStackDataAccess"/> touches nothing until used (data-access.md rule 5).</summary>
public class V2DataAccessRegistrationTests
{
    private const string Legacy = "Host=localhost;Database=legacy";

    [Fact]
    public async Task AddTextStackDataAccess_NoV2ConnectionString_ResolvesAndTheFirstOpenNamesTheMissingKey()
    {
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess(Legacy, null)
            .BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = true });

        Type[] v2Ports = [typeof(IV2UnitOfWork), typeof(ILibraryRepository), typeof(IReadingStateRepository), typeof(IReadingSessionRepository),
            typeof(IAnnotationRepository), typeof(IVocabularyRepository),
            typeof(ISharedChapterRepository), typeof(ICheckpointRepository),
            typeof(IBookInsightRepository), typeof(IReviewQuestionRepository),
            typeof(IUserRepository), typeof(ISessionTokenRepository), typeof(IOAuthRepository), typeof(IDeviceLoginRepository),
            typeof(IMcpKeyRepository), typeof(IAccountMergeRepository), typeof(V2LlmTraceWriter), typeof(V2AgentRunWriter), typeof(IEvalRunRepository),
            typeof(IAdminSettingsRepository), typeof(IBookChapterRepository), typeof(IIngestionJobRepository)];
        foreach (var port in v2Ports)
            Assert.NotNull(services.GetRequiredService(port));
        var open = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            services.GetRequiredService<V2DataSource>().OpenConnectionAsync(TestContext.Current.CancellationToken).AsTask());
        Assert.Contains("ConnectionStrings:V2", open.Message);
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
        Assert.NotNull(services.GetService<IV2UnitOfWork>());
        Assert.NotNull(services.GetService<IReadingStateRepository>());
        Assert.NotNull(services.GetService<IReadingSessionRepository>());
        Assert.NotNull(services.GetService<IAnnotationRepository>());
        Assert.NotNull(services.GetService<IVocabularyRepository>());
        Assert.NotNull(services.GetService<ISharedChapterRepository>());
        Assert.NotNull(services.GetService<ICheckpointRepository>());
        Assert.NotNull(services.GetService<IBookInsightRepository>());
        Assert.NotNull(services.GetService<IReviewQuestionRepository>());
        Assert.NotNull(services.GetService<IUserRepository>());
        Assert.NotNull(services.GetService<ISessionTokenRepository>());
        Assert.NotNull(services.GetService<IOAuthRepository>());
        Assert.NotNull(services.GetService<IDeviceLoginRepository>());
        Assert.NotNull(services.GetService<IMcpKeyRepository>());
        Assert.NotNull(services.GetService<IAccountMergeRepository>());
        Assert.NotNull(services.GetService<V2LlmTraceWriter>());
        Assert.NotNull(services.GetService<V2AgentRunWriter>());
        Assert.NotNull(services.GetService<IEvalRunRepository>());
        Assert.NotNull(services.GetService<IAdminSettingsRepository>());
        Assert.NotNull(services.GetService<IBookChapterRepository>());
        Assert.NotNull(services.GetService<IIngestionJobRepository>());
    }
}
