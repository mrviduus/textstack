using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Domain.Library;
using Domain.Reading;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Reading;

public class ReadingStateRepositoryTests(V2PostgresFixture db)
{
    private readonly ReadingStateRepository _repo = new(db.DataSource);
    private readonly LibraryRepository _library = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string Page(int page) => $$$"""{"version":1,"scheme":"pdf-page","value":{"page":{{{page}}}}}""";

    private static BookFile NewFile() => new()
    {
        Id = Guid.NewGuid(),
        Sha256 = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),
        ByteSize = 1024,
        OriginalName = "book.pdf",
        Format = "pdf",
    };

    /// <summary>A position on page <paramref name="page"/> of 10, with no frontier offered.</summary>
    private static ReadingState At(Guid fileId, int page) => new()
    {
        FileId = fileId,
        CurrentLocator = Page(page),
        BookFraction = page / 10m,
        ClientRecordedAt = DateTimeOffset.UtcNow,
    };

    private async Task<(Guid User, Guid Book, Guid File)> ReaderWithBookAsync()
    {
        var user = await db.NewReaderAsync();
        var book = await _library.ImportAsync(new Book { Id = Guid.NewGuid(), UserId = user, Title = "A book" }, NewFile(), Ct);
        return (user, book.Id, book.CurrentFile!.Id);
    }

    private static void AssertSameJson(string expected, string? actual) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), JsonNode.Parse(actual!)), $"{expected} != {actual}");

    [Fact]
    public async Task AdvanceAsync_FirstWrite_CreatesTheRowAtRevisionOne()
    {
        var (user, book, file) = await ReaderWithBookAsync();

        var result = await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        Assert.True(result.Accepted);
        var stored = (await _repo.GetAsync(user, book, Ct))!;
        Assert.Equal((1L, file, 0.3m, 0.3m), (stored.Revision, stored.FileId, stored.BookFraction, stored.FrontierFraction));
        AssertSameJson(Page(3), stored.CurrentLocator);
        AssertSameJson(Page(3), stored.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FirstWriteWhenARowExists_LosesAndReturnsTheRow()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), null, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((1L, 0.3m), (result.Current!.Revision, result.Current.BookFraction));
    }

    [Fact]
    public async Task AdvanceAsync_MatchingRevision_WinsAndIncrementsTheRevision()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 5), 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((2L, 0.5m), (result.Current!.Revision, result.Current.BookFraction));
        Assert.Equal(2L, (await _repo.GetAsync(user, book, Ct))!.Revision);
    }

    [Fact]
    public async Task AdvanceAsync_StaleRevision_LosesAndReturnsTheWinnersStateIntact()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);
        await _repo.AdvanceAsync(user, book, At(file, 6), 1, Ct);

        var result = await _repo.AdvanceAsync(user, book, At(file, 4), 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((2L, 0.6m), (result.Current!.Revision, result.Current.BookFraction));
        AssertSameJson(Page(6), result.Current.CurrentLocator);
        Assert.Equal(0.6m, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_TwoWritersWithTheSameRevision_ExactlyOneWins()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var results = await Task.WhenAll(
            _repo.AdvanceAsync(user, book, At(file, 4), 1, Ct),
            _repo.AdvanceAsync(user, book, At(file, 5), 1, Ct));

        var winner = Assert.Single(results, r => r.Accepted);
        var loser = Assert.Single(results, r => !r.Accepted);
        Assert.Equal(2L, winner.Current!.Revision);
        Assert.Equal(winner.Current.BookFraction, loser.Current!.BookFraction);
        Assert.Equal(winner.Current.BookFraction, (await _repo.GetAsync(user, book, Ct))!.BookFraction);
    }

    [Fact]
    public async Task AdvanceAsync_MovingBack_KeepsTheFrontierLocatorAndFraction()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 8), null, Ct);

        var back = At(file, 2);
        back.FrontierLocator = Page(5); // a device that knew less: still behind the stored frontier
        back.FrontierFraction = 0.5m;
        var result = await _repo.AdvanceAsync(user, book, back, 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((0.2m, 0.8m), (result.Current!.BookFraction, result.Current.FrontierFraction));
        AssertSameJson(Page(8), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FrontierAheadOfStored_MovesItForward()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 3), null, Ct);

        var state = At(file, 2);
        state.FrontierLocator = Page(9);
        state.FrontierFraction = 0.9m;
        var result = await _repo.AdvanceAsync(user, book, state, 1, Ct);

        Assert.Equal(0.9m, result.Current!.FrontierFraction);
        AssertSameJson(Page(9), result.Current.FrontierLocator);
    }

    [Fact]
    public async Task AdvanceAsync_FileThatIsNotTheCurrentOne_Loses()
    {
        var (user, book, oldFile) = await ReaderWithBookAsync();
        var newFile = (await _library.ReplaceFileAsync(user, book, NewFile(), Ct))!.Current.Id;

        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 3), null, Ct)).Accepted);
        Assert.True((await _repo.AdvanceAsync(user, book, At(newFile, 3), null, Ct)).Accepted);
        Assert.False((await _repo.AdvanceAsync(user, book, At(oldFile, 4), 1, Ct)).Accepted);
    }

    [Fact]
    public async Task ResetAsync_ExistingState_ForgetsItSoTheNextWriteStartsOver()
    {
        var (user, book, file) = await ReaderWithBookAsync();
        await _repo.AdvanceAsync(user, book, At(file, 8), null, Ct);

        Assert.True(await _repo.ResetAsync(user, book, Ct));
        Assert.Null(await _repo.GetAsync(user, book, Ct));
        Assert.False(await _repo.ResetAsync(user, book, Ct));
        var restart = await _repo.AdvanceAsync(user, book, At(file, 1), null, Ct);
        Assert.Equal((1L, 0.1m), (restart.Current!.Revision, restart.Current.FrontierFraction));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task GetAsync_AlicesBookAsBob_ReturnsNull()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        Assert.Null(await _repo.GetAsync(bob, book, Ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task AdvanceAsync_AlicesBookAsBob_LosesAndChangesNothing(long? expectedRevision)
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        var result = await _repo.AdvanceAsync(bob, book, At(file, 9), expectedRevision, Ct);

        Assert.Equal((false, (ReadingState?)null), (result.Accepted, result.Current));
        var alices = (await _repo.GetAsync(alice, book, Ct))!;
        Assert.Equal((1L, 0.3m), (alices.Revision, alices.BookFraction));
    }

    [Fact]
    public async Task ResetAsync_AlicesBookAsBob_ReturnsFalseAndKeepsHerState()
    {
        var (alice, book, file) = await ReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AdvanceAsync(alice, book, At(file, 3), null, Ct);

        Assert.False(await _repo.ResetAsync(bob, book, Ct));
        Assert.NotNull(await _repo.GetAsync(alice, book, Ct));
    }
}
