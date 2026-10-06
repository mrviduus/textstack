using Api.Endpoints;
using Api.Sites;
using Application.Common.Interfaces;
using Application.Vocabulary;
using Domain.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Npgsql;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A double tap (or a retry racing the first request) runs two check-then-insert saves at once. Both
/// see no row, both INSERT, and the loser hit the unique index — 23505, a 500 to the client (live:
/// 1x200 5x500 on six parallel vocabulary saves). The loser must answer like the dedup path does.
/// Each test makes SaveChanges insert a "winner" row and then throw the unique violation, which is
/// exactly what the losing request observes.
/// </summary>
public class DoubleSubmitTests
{
    private static readonly Guid UserId = Guid.NewGuid();
    private static readonly Guid SiteId = Guid.NewGuid();

    private static DbUpdateException UniqueViolation() =>
        new("save failed", new PostgresException("duplicate key", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation));

    private static HttpContext Ctx()
    {
        var ctx = new DefaultHttpContext();
        ctx.Items[Api.Middleware.McpKeyAuthMiddleware.UserIdItemKey] = UserId;
        ctx.Items["SiteContext"] = new SiteContext(SiteId, "general", "localhost", "en", "default", false, false, false, "{}");
        return ctx;
    }

    private sealed class VocabHarness
    {
        public List<VocabularyWord> Words { get; } = [];
        public List<PendingVocabularyWord> Pending { get; } = [];
        public List<UserVocabularySettings> Settings { get; } = [];
        public Mock<IAppDbContext> Db { get; } = new();
        public Action? OnSave { get; set; }

        public VocabHarness()
        {
            Db.Setup(x => x.VocabularyWords).Returns(new FakeDbSet<VocabularyWord>(Words));
            Db.Setup(x => x.PendingVocabularyWords).Returns(new FakeDbSet<PendingVocabularyWord>(Pending));
            Db.Setup(x => x.WordLookups).Returns(new FakeDbSet<WordLookup>([]));
            Db.Setup(x => x.UserVocabularySettings).Returns(new FakeDbSet<UserVocabularySettings>(Settings));
            Db.Setup(x => x.Users).Returns(new FakeDbSet<User>([]));
            Db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(() =>
            {
                OnSave?.Invoke();
                return 1;
            });
        }

        public Task<IResult> Save(string word) => VocabularyEndpoints.SaveWord(
            new SaveWordRequest(word, "en", "переклад", null, null, null, null, null, null, NativeLanguage: "uk"),
            Ctx(), null!, Db.Object,
            new DailyCapService(Db.Object, TestEntitlements.Resolver),
            Mock.Of<IFrequencyFilter>(), Mock.Of<IServiceScopeFactory>(),
            NullLogger<IAppDbContext>.Instance, CancellationToken.None);
    }

    [Fact]
    public async Task SaveWord_ConcurrentSaveWonTheSrsInsert_ReturnsAlreadySaved()
    {
        var h = new VocabHarness();
        var winner = new VocabularyWord { Id = Guid.NewGuid(), UserId = UserId, SiteId = SiteId, Word = "quiver", Language = "en" };
        h.OnSave = () =>
        {
            h.Words.Add(winner);
            throw UniqueViolation();
        };

        var result = await h.Save("Quiver");

        var ok = Assert.IsType<Ok<SaveWordResponse>>(result);
        Assert.Equal("already_saved", ok.Value!.Outcome);
        Assert.Equal(winner.Id, ok.Value.Word!.Id);
        Assert.Equal([winner], h.Words); // the doomed insert was dropped from the context
    }

    [Fact]
    public async Task SaveWord_ConcurrentSaveWonThePendingInsert_ReturnsAlreadyPending()
    {
        var h = new VocabHarness();
        h.Settings.Add(new UserVocabularySettings { UserId = UserId, SiteId = SiteId, DailyNewCap = 0 }); // → pending bucket
        var winner = new PendingVocabularyWord { Id = Guid.NewGuid(), UserId = UserId, SiteId = SiteId, Word = "quiver", Language = "en" };
        h.OnSave = () =>
        {
            h.Pending.Add(winner);
            throw UniqueViolation();
        };

        var result = await h.Save("quiver");

        var ok = Assert.IsType<Ok<SaveWordResponse>>(result);
        Assert.Equal("pending", ok.Value!.Outcome);
        Assert.Equal(winner.Id, ok.Value.PendingId);
    }

    [Fact]
    public async Task SaveWord_UniqueViolationWithNoWinnerRow_Throws()
    {
        var h = new VocabHarness { OnSave = () => throw UniqueViolation() };

        await Assert.ThrowsAsync<DbUpdateException>(() => h.Save("quiver"));
    }

    [Fact]
    public async Task AddToLibrary_ConcurrentAddWonTheInsert_ReturnsOkWithExistingRow()
    {
        var editionId = Guid.NewGuid();
        var editions = new List<Edition>
        {
            new() { Id = editionId, WorkId = Guid.NewGuid(), SiteId = SiteId, Language = "en", Slug = "dracula", Title = "Dracula" },
        };
        var library = new List<UserLibrary>();
        var winner = new UserLibrary
        {
            Id = Guid.NewGuid(), UserId = UserId, EditionId = editionId, CreatedAt = DateTimeOffset.UnixEpoch,
        };
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Editions).Returns(new FakeDbSet<Edition>(editions));
        db.Setup(x => x.UserLibraries).Returns(new FakeDbSet<UserLibrary>(library));
        db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(() =>
        {
            library.Add(winner);
            throw UniqueViolation();
        });

        var result = await UserDataEndpoints.AddToLibrary(editionId, Ctx(), null!, db.Object, CancellationToken.None);

        var ok = Assert.IsType<Ok<LibraryItemDto>>(result);
        Assert.Equal(DateTimeOffset.UnixEpoch, ok.Value!.CreatedAt);
        Assert.Equal([winner], library);
    }
}
