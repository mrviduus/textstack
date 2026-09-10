using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;

namespace TextStack.UnitTests.Fakes;

/// <summary>
/// In-memory <see cref="IAppDbContext"/> for the DriftDetectionWorker per-feature flow tests. Only
/// the two sets the worker reads/writes (<see cref="DriftCentroids"/>, <see cref="LlmTraces"/>) are
/// backed by lists; everything else throws so a stray access is loud. <see cref="SaveChangesAsync"/>
/// is a no-op count (FakeDbSet.Add already appended to the backing list).
/// </summary>
internal sealed class FakeAppDbContext : IAppDbContext
{
    public List<DriftCentroid> DriftStore { get; } = [];
    public List<LlmTrace> TraceStore { get; } = [];
    public int SaveCalls { get; private set; }

    private readonly FakeDbSet<DriftCentroid> _drift;
    private readonly FakeDbSet<LlmTrace> _traces;

    public FakeAppDbContext()
    {
        _drift = new FakeDbSet<DriftCentroid>(DriftStore);
        _traces = new FakeDbSet<LlmTrace>(TraceStore);
    }

    public DbSet<DriftCentroid> DriftCentroids => _drift;
    public DbSet<LlmTrace> LlmTraces => _traces;

    public Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        SaveCalls++;
        return Task.FromResult(0);
    }

    public DatabaseFacade Database => throw new NotSupportedException();
    public Task<IDbContextTransaction> BeginTransactionAsync(CancellationToken ct = default) =>
        throw new NotSupportedException();

    public DbSet<Site> Sites => throw new NotSupportedException();
    public DbSet<SiteDomain> SiteDomains => throw new NotSupportedException();
    public DbSet<Work> Works => throw new NotSupportedException();
    public DbSet<Edition> Editions => throw new NotSupportedException();
    public DbSet<Chapter> Chapters => throw new NotSupportedException();
    public DbSet<BookFile> BookFiles => throw new NotSupportedException();
    public DbSet<IngestionJob> IngestionJobs => throw new NotSupportedException();
    public DbSet<User> Users => throw new NotSupportedException();
    public DbSet<UserLibrary> UserLibraries => throw new NotSupportedException();
    public DbSet<ReadingProgress> ReadingProgresses => throw new NotSupportedException();
    public DbSet<Bookmark> Bookmarks => throw new NotSupportedException();
    public DbSet<Note> Notes => throw new NotSupportedException();
    public DbSet<AdminUser> AdminUsers => throw new NotSupportedException();
    public DbSet<AdminRefreshToken> AdminRefreshTokens => throw new NotSupportedException();
    public DbSet<UserRefreshToken> UserRefreshTokens => throw new NotSupportedException();
    public DbSet<Author> Authors => throw new NotSupportedException();
    public DbSet<EditionAuthor> EditionAuthors => throw new NotSupportedException();
    public DbSet<Genre> Genres => throw new NotSupportedException();
    public DbSet<TextStackImport> TextStackImports => throw new NotSupportedException();
    public DbSet<SsgRebuildJob> SsgRebuildJobs => throw new NotSupportedException();
    public DbSet<SsgRebuildResult> SsgRebuildResults => throw new NotSupportedException();
    public DbSet<BookAsset> BookAssets => throw new NotSupportedException();
    public DbSet<LintResult> LintResults => throw new NotSupportedException();
    public DbSet<UserBook> UserBooks => throw new NotSupportedException();
    public DbSet<UserChapter> UserChapters => throw new NotSupportedException();
    public DbSet<UserBookFile> UserBookFiles => throw new NotSupportedException();
    public DbSet<UserIngestionJob> UserIngestionJobs => throw new NotSupportedException();
    public DbSet<UserBookBookmark> UserBookBookmarks => throw new NotSupportedException();
    public DbSet<Domain.Entities.AdminSettings> AdminSettings => throw new NotSupportedException();
    public DbSet<Highlight> Highlights => throw new NotSupportedException();
    public DbSet<ReadingSession> ReadingSessions => throw new NotSupportedException();
    public DbSet<ReadingGoal> ReadingGoals => throw new NotSupportedException();
    public DbSet<UserAchievement> UserAchievements => throw new NotSupportedException();
    public DbSet<VocabularyWord> VocabularyWords => throw new NotSupportedException();
    public DbSet<VocabularyReview> VocabularyReviews => throw new NotSupportedException();
    public DbSet<UserVocabularySettings> UserVocabularySettings => throw new NotSupportedException();
    public DbSet<PendingVocabularyWord> PendingVocabularyWords => throw new NotSupportedException();
    public DbSet<WordLookup> WordLookups => throw new NotSupportedException();
    public DbSet<WordFrequency> WordFrequencies => throw new NotSupportedException();
    public DbSet<WordCluster> WordClusters => throw new NotSupportedException();
    public DbSet<AutoPublishJob> AutoPublishJobs => throw new NotSupportedException();
    public DbSet<PasswordResetToken> PasswordResetTokens => throw new NotSupportedException();
    public DbSet<DeviceAuthorization> DeviceAuthorizations => throw new NotSupportedException();
    public DbSet<BookQualityJob> BookQualityJobs => throw new NotSupportedException();
    public DbSet<SeoTemplate> SeoTemplates => throw new NotSupportedException();
    public DbSet<SeoBackfillJob> SeoBackfillJobs => throw new NotSupportedException();
    public DbSet<SeoBackfillSettings> SeoBackfillSettings => throw new NotSupportedException();
    public DbSet<Collection> Collections => throw new NotSupportedException();
    public DbSet<BookCollection> BookCollections => throw new NotSupportedException();
    public DbSet<ShadowRun> ShadowRuns => throw new NotSupportedException();
    public DbSet<ModelRegistration> Models => throw new NotSupportedException();
    public DbSet<ModelPromotion> ModelPromotions => throw new NotSupportedException();
    public DbSet<EvalRun> EvalRuns => throw new NotSupportedException();
    public DbSet<AgentRun> AgentRuns => throw new NotSupportedException();
    public DbSet<TutorSession> TutorSessions => throw new NotSupportedException();
    public DbSet<PodcastGenerationJob> PodcastGenerationJobs => throw new NotSupportedException();
    public DbSet<BookInsight> BookInsights => throw new NotSupportedException();
    public DbSet<McpAccessKey> McpAccessKeys => throw new NotSupportedException();
}
