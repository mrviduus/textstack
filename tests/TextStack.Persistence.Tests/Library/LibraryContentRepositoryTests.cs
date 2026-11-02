using Application.Library;
using Domain.Library;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Library;

/// <summary>The stored-bytes half of <see cref="LibraryRepository"/>: attach under the quota, stop syncing, cover, the superseded sweep.</summary>
public class LibraryContentRepositoryTests(V2PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private const long NoLimit = long.MaxValue;

    private static string KeyOf(Book book) => $"library/{book.UserId}/{book.Id}/{book.CurrentFile!.Id}.epub";

    private Task<ContentAttachment> AttachAsync(Book book, long limit = NoLimit, Action? place = null) =>
        _repo.AttachContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, KeyOf(book), limit, place ?? (() => { }), Ct);

    [Fact]
    public async Task AttachContentAsync_CurrentFileThatFits_SetsTheKeyClearsTheStampAndBumpsTheBook()
    {
        var book = await db.NewReaderWithBookAsync();
        await db.ExecAsync("UPDATE book_files SET content_removed_at = now() WHERE id = @id", new { id = book.CurrentFile!.Id });
        var placed = false;

        var result = await AttachAsync(book, place: () => placed = true);

        Assert.Equal((AttachOutcome.Attached, KeyOf(book), (DateTimeOffset?)null), (result.Outcome, result.File!.ServerStorageKey, result.File.ContentRemovedAt));
        Assert.True(placed);
        Assert.True((await _repo.GetAsync(book.UserId, book.Id, Ct))!.UpdatedAt > book.UpdatedAt);
    }

    [Fact]
    public async Task AttachContentAsync_StoredAlready_IsAlreadyStoredAndPlacesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        var placed = false;

        var result = await AttachAsync(book, place: () => placed = true);

        Assert.Equal(AttachOutcome.AlreadyStored, result.Outcome);
        Assert.False(placed);
    }

    [Fact]
    public async Task AttachContentAsync_SupersededVersion_IsFileReplacedWithTheCurrentFile()
    {
        var book = await db.NewReaderWithBookAsync();
        var replaced = await db.ReplaceFileAsync(book);

        var result = await AttachAsync(book);

        Assert.Equal((AttachOutcome.FileReplaced, replaced.Current!.Id), (result.Outcome, result.File!.Id));
        Assert.Null((await _repo.GetFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct))!.ServerStorageKey);
    }

    [Fact]
    public async Task AttachContentAsync_RemovedBook_IsBookRemovedAndPlacesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);
        var placed = false;

        var result = await AttachAsync(book, place: () => placed = true);

        Assert.Equal((AttachOutcome.BookRemoved, book.CurrentFile!.Id), (result.Outcome, result.Book!.CurrentFile!.Id));
        Assert.False(placed);
    }

    [Fact]
    public async Task AttachContentAsync_OverTheLimit_IsQuotaExceededWithWhatIsStored()
    {
        var user = await db.NewReaderAsync();
        var stored = await db.NewBookAsync(user);
        await AttachAsync(stored);
        var next = await db.NewBookAsync(user);
        var placed = false;

        var result = await AttachAsync(next, limit: 2047, place: () => placed = true);

        Assert.Equal((AttachOutcome.QuotaExceeded, 1024L), (result.Outcome, result.Used));
        Assert.False(placed);
        Assert.Equal(AttachOutcome.Attached, (await AttachAsync(next, limit: 2048)).Outcome);
    }

    [Fact]
    public async Task AttachContentAsync_PlacingTheBytesThrows_RollsBack()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<IOException>(() => AttachAsync(book, place: () => throw new IOException("disk full")));

        Assert.Null((await _repo.GetFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct))!.ServerStorageKey);
    }

    [Fact]
    public async Task AttachContentAsync_ConcurrentCompletesPastTheLimit_StoreExactlyThoseThatFit()
    {
        var user = await db.NewReaderAsync();
        var books = new List<Book>();
        for (var i = 0; i < 6; i++) books.Add(await db.NewBookAsync(user));

        // Each file is 1024 bytes and three fit; the sleep holds the decision open while the others arrive.
        var results = await Task.WhenAll(books.Select(b => Task.Run(() => AttachAsync(b, limit: 3 * 1024, place: () => Thread.Sleep(50)), Ct)));

        Assert.Equal(3, results.Count(r => r.Outcome == AttachOutcome.Attached));
        Assert.Equal(3, results.Count(r => r.Outcome == AttachOutcome.QuotaExceeded));
        Assert.Equal(3 * 1024L, await _repo.StoredBytesAsync(user, Ct));
    }

    [Fact]
    public async Task AttachContentAsync_AnotherUsersFile_IsNotFoundAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var result = await _repo.AttachContentAsync(bob, alices.Id, alices.CurrentFile!.Id, "library/x.epub", NoLimit, () => { }, Ct);

        Assert.Equal(AttachOutcome.NotFound, result.Outcome);
        Assert.Null((await _repo.GetFileAsync(alices.UserId, alices.Id, alices.CurrentFile.Id, Ct))!.ServerStorageKey);
    }

    [Fact]
    public async Task RemoveContentAsync_StoredFile_ReturnsTheClearedKeyStampsTheRowAndBumpsTheBook()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        var before = (await _repo.GetAsync(book.UserId, book.Id, Ct))!.UpdatedAt;

        Assert.Equal(KeyOf(book), await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct));

        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((string?)null, read.CurrentFile!.ServerStorageKey);
        Assert.NotNull(read.CurrentFile.ContentRemovedAt);
        Assert.True(read.UpdatedAt > before);
    }

    [Fact]
    public async Task RemoveContentAsync_NothingStoredThenAgain_StampsOnceAndReturnsNoKey()
    {
        var book = await db.NewReaderWithBookAsync();
        Assert.Null(await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct));
        var first = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.NotNull(first.CurrentFile!.ContentRemovedAt);

        Assert.Null(await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct));

        var second = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((first.UpdatedAt, first.CurrentFile!.ContentRemovedAt), (second.UpdatedAt, second.CurrentFile!.ContentRemovedAt));
    }

    [Fact]
    public async Task RemoveContentAsync_AnotherUsersFile_ChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        await AttachAsync(alices);

        Assert.Null(await _repo.RemoveContentAsync(await db.NewReaderAsync(), alices.Id, alices.CurrentFile!.Id, Ct));

        Assert.NotNull((await _repo.GetFileAsync(alices.UserId, alices.Id, alices.CurrentFile.Id, Ct))!.ServerStorageKey);
    }

    [Fact]
    public async Task RemoveContentAsync_WhileAnAttachHoldsTheRow_ClearsAndReturnsTheKeyThatAttachCommitted()
    {
        var book = await db.NewReaderWithBookAsync();
        using var placing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var attach = Task.Run(() => AttachAsync(book, place: () => { placing.Set(); release.Wait(); }), Ct);
        placing.Wait(Ct);

        var remove = Task.Run(() => _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct), Ct);
        await Task.Delay(200, Ct);
        release.Set();
        await attach;

        Assert.Equal(KeyOf(book), await remove);
        Assert.Null((await _repo.GetFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct))!.ServerStorageKey);
    }

    [Fact]
    public async Task AttachContentAsync_PlaceRunsAfterTheRowUpdate_InsideTheTransaction()
    {
        var book = await db.NewReaderWithBookAsync();
        string? seenFromOutside = "unread";

        await AttachAsync(book, place: () => seenFromOutside = db.ScalarAsync<string?>(
            "SELECT server_storage_key FROM book_files WHERE id = @id", new { id = book.CurrentFile!.Id }).GetAwaiter().GetResult());

        // Updated but not committed when the bytes were placed: another connection still read null.
        Assert.Null(seenFromOutside);
    }

    [Fact]
    public async Task ListStorageKeysAsync_FilesAndCover_ListsOnlyTheUsersKeys()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        await _repo.SetCoverAsync(book.UserId, book.Id, "library/c/cover.png", Ct);
        await AttachAsync(await db.NewReaderWithBookAsync());

        Assert.Equal(new[] { KeyOf(book), "library/c/cover.png" }.Order(), (await _repo.ListStorageKeysAsync(book.UserId, Ct)).Order());
    }

    [Fact]
    public async Task ReferencedKeysAsync_MixOfKeys_AnswersOnlyThoseAFileOrACoverNames()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        var cover = $"library/{Guid.NewGuid()}/cover.png";
        await _repo.SetCoverAsync(book.UserId, book.Id, cover, Ct);

        var referenced = await _repo.ReferencedKeysAsync([KeyOf(book), cover, "library/orphan.epub"], Ct);

        Assert.Equal(new[] { cover, KeyOf(book) }.Order(), referenced.Order());
    }

    [Fact]
    public async Task StoredBytesAsync_StoredAndUnstoredFilesOfTwoUsers_CountsOnlyTheUsersStoredOnes()
    {
        var user = await db.NewReaderAsync();
        await AttachAsync(await db.NewBookAsync(user));
        await db.NewBookAsync(user);
        await AttachAsync(await db.NewReaderWithBookAsync());

        Assert.Equal(1024L, await _repo.StoredBytesAsync(user, Ct));
    }

    [Fact]
    public async Task SetCoverAsync_OwnBook_SetsTheKeyAndBumpsTheBook()
    {
        var book = await db.NewReaderWithBookAsync();

        var updated = await _repo.SetCoverAsync(book.UserId, book.Id, "library/cover.png", Ct);

        Assert.Equal(("library/cover.png", book.CurrentFile!.Id), (updated!.CoverKey, updated.CurrentFile!.Id));
        Assert.True(updated.UpdatedAt > book.UpdatedAt);
    }

    [Fact]
    public async Task SetCoverAsync_AnotherUsersBook_IsNullAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();

        Assert.Null(await _repo.SetCoverAsync(await db.NewReaderAsync(), alices.Id, "library/cover.png", Ct));

        Assert.Null((await _repo.GetAsync(alices.UserId, alices.Id, Ct))!.CoverKey);
    }

    [Fact]
    public async Task ListSupersededWithContentAsync_ThenForget_ListsTheStoredOldVersionOnceAndKeepsTheCurrent()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        var replaced = await db.ReplaceFileAsync(book);
        await AttachAsync((await _repo.GetAsync(book.UserId, book.Id, Ct))!);

        Assert.Contains(await _repo.ListSupersededWithContentAsync(int.MaxValue, Ct), f => f.Id == book.CurrentFile!.Id);
        Assert.DoesNotContain(await _repo.ListSupersededWithContentAsync(int.MaxValue, Ct), f => f.Id == replaced.Current!.Id);

        await _repo.ForgetSupersededContentAsync(book.CurrentFile!.Id, Ct);
        await _repo.ForgetSupersededContentAsync(replaced.Current!.Id, Ct);

        Assert.DoesNotContain(await _repo.ListSupersededWithContentAsync(int.MaxValue, Ct), f => f.Id == book.CurrentFile.Id);
        Assert.NotNull((await _repo.GetFileAsync(book.UserId, book.Id, replaced.Current.Id, Ct))!.ServerStorageKey);
    }
}
