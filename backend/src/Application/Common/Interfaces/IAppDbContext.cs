using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;

namespace Application.Common.Interfaces;

public interface IAppDbContext
{
    DatabaseFacade Database { get; }

    DbSet<Site> Sites { get; }
    DbSet<SiteDomain> SiteDomains { get; }
    DbSet<Work> Works { get; }
    DbSet<Edition> Editions { get; }
    DbSet<Chapter> Chapters { get; }
    DbSet<BookFile> BookFiles { get; }
    DbSet<IngestionJob> IngestionJobs { get; }
    DbSet<User> Users { get; }
    DbSet<UserLibrary> UserLibraries { get; }
    DbSet<ReadingProgress> ReadingProgresses { get; }
    DbSet<Bookmark> Bookmarks { get; }
    DbSet<Note> Notes { get; }
    DbSet<AdminUser> AdminUsers { get; }
    DbSet<AdminRefreshToken> AdminRefreshTokens { get; }
    DbSet<UserRefreshToken> UserRefreshTokens { get; }
    DbSet<Author> Authors { get; }
    DbSet<EditionAuthor> EditionAuthors { get; }
    DbSet<Genre> Genres { get; }
    DbSet<TextStackImport> TextStackImports { get; }
    DbSet<SsgRebuildJob> SsgRebuildJobs { get; }
    DbSet<SsgRebuildResult> SsgRebuildResults { get; }
    DbSet<BookAsset> BookAssets { get; }
    DbSet<LintResult> LintResults { get; }
    DbSet<UserBook> UserBooks { get; }
    DbSet<UserChapter> UserChapters { get; }
    DbSet<UserBookFile> UserBookFiles { get; }
    DbSet<UserIngestionJob> UserIngestionJobs { get; }
    DbSet<UserBookBookmark> UserBookBookmarks { get; }
    DbSet<Domain.Entities.AdminSettings> AdminSettings { get; }
    DbSet<Highlight> Highlights { get; }
    DbSet<ReadingSession> ReadingSessions { get; }
    DbSet<ReadingGoal> ReadingGoals { get; }
    DbSet<UserAchievement> UserAchievements { get; }
    DbSet<VocabularyWord> VocabularyWords { get; }
    DbSet<VocabularyReview> VocabularyReviews { get; }
    DbSet<UserVocabularySettings> UserVocabularySettings { get; }
    DbSet<PendingVocabularyWord> PendingVocabularyWords { get; }
    DbSet<WordLookup> WordLookups { get; }
    DbSet<WordFrequency> WordFrequencies { get; }
    DbSet<WordCluster> WordClusters { get; }
    DbSet<AutoPublishJob> AutoPublishJobs { get; }
    DbSet<PasswordResetToken> PasswordResetTokens { get; }
    DbSet<DeviceAuthorization> DeviceAuthorizations { get; }
    DbSet<McpAccessKey> McpAccessKeys { get; }
    DbSet<BookQualityJob> BookQualityJobs { get; }
    DbSet<SeoTemplate> SeoTemplates { get; }
    DbSet<SeoBackfillJob> SeoBackfillJobs { get; }
    DbSet<SeoBackfillSettings> SeoBackfillSettings { get; }
    DbSet<Collection> Collections { get; }
    DbSet<BookCollection> BookCollections { get; }
    DbSet<LlmTrace> LlmTraces { get; }
    DbSet<ShadowRun> ShadowRuns { get; }
    DbSet<ModelRegistration> Models { get; }
    DbSet<ModelPromotion> ModelPromotions { get; }
    DbSet<EvalRun> EvalRuns { get; }
    DbSet<AgentRun> AgentRuns { get; }
    DbSet<TutorSession> TutorSessions { get; }
    DbSet<DriftCentroid> DriftCentroids { get; }
    DbSet<PodcastGenerationJob> PodcastGenerationJobs { get; }
    DbSet<BookInsight> BookInsights { get; }
    /// <summary>Per-user RAG chunks. Exposed here (not only on the concrete context) because
    /// guest-merge has to re-parent them: UserId is denormalized off UserBook and has no FK to User,
    /// so these rows outlive a deleted guest instead of cascading with it.</summary>
    DbSet<UserChapterChunk> UserChapterChunks { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);

    /// <summary>Begin an explicit DB transaction. Caller must Commit or Dispose.</summary>
    Task<IDbContextTransaction> BeginTransactionAsync(CancellationToken ct = default);
}
