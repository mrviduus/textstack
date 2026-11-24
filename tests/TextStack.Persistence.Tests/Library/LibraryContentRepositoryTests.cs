using Application.Library;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Library;

/// <summary>The stored-bytes half of <see cref="LibraryRepository"/>: attach under the quota, stop syncing, cover, the keys released and listed.</summary>
public class LibraryContentRepositoryTests(PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private const long NoLimit = long.MaxValue;

    private static string KeyOf(Book book) => $"library/{book.UserId}/{book.Id}/{book.CurrentFile!.Id}.epub";

    private Task<ContentAttachment> AttachAsync(Book book, long limit = NoLimit, Action? place = null) =>
        _repo.AttachContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, KeyOf(book), limit, place ?? (() => { }), Ct);

    private async Task<string?> StoredKeyAsync(Book book, Guid? fileId = null) =>
        (await _repo.GetFileAsync(book.UserId, book.Id, fileId ?? book.CurrentFile!.Id, Ct))!.ServerStorageKey;

    // The bytes are placed after the row update and before the commit: another connection still reads no key.
    [Fact]
    public async Task AttachContentAsync_AReaderSyncsAFileThatFits_StoresItInsideTheTransactionOnceAndBumpsTheBook()
    {
        var book = await db.NewReaderWithBookAsync();
        await db.ExecAsync("UPDATE book_files SET content_removed_at = now() WHERE id = @id", new { id = book.CurrentFile!.Id });
        Assert.NotNull((await _repo.GetFileAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct))!.ContentRemovedAt);
        var placed = 0;
        string? seenFromOutside = "unread";

        var result = await AttachAsync(book, place: () =>
        {
            placed++;
            seenFromOutside = db.ScalarAsync<string?>(
                "SELECT server_storage_key FROM book_files WHERE id = @id", new { id = book.CurrentFile.Id }).GetAwaiter().GetResult();
        });

        Assert.Equal((AttachOutcome.Attached, KeyOf(book), (DateTimeOffset?)null), (result.Outcome, result.File!.ServerStorageKey, result.File.ContentRemovedAt));
        Assert.Equal(1, placed);
        Assert.Null(seenFromOutside);
        Assert.True((await _repo.GetAsync(book.UserId, book.Id, Ct))!.UpdatedAt > book.UpdatedAt);

        // The second device completes the same upload: already stored, nothing placed again.
        Assert.Equal(AttachOutcome.AlreadyStored, (await AttachAsync(book, place: () => placed++)).Outcome);
        Assert.Equal(1, placed);
    }

    [Fact]
    public async Task AttachContentAsync_TheBookChangedUnderTheUpload_PlacesNothingAndSaysWhy()
    {
        var replacedBook = await db.NewReaderWithBookAsync();
        var replaced = await db.ReplaceFileAsync(replacedBook);
        var removedBook = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(removedBook.UserId, removedBook.Id, Ct);
        var placed = false;

        var superseded = await AttachAsync(replacedBook, place: () => placed = true);
        var removed = await AttachAsync(removedBook, place: () => placed = true);

        Assert.Equal((AttachOutcome.FileReplaced, replaced.Current!.Id), (superseded.Outcome, superseded.File!.Id));
        Assert.Null(await StoredKeyAsync(replacedBook));
        Assert.Equal((AttachOutcome.BookRemoved, removedBook.CurrentFile!.Id), (removed.Outcome, removed.Book!.CurrentFile!.Id));
        Assert.False(placed);
    }

    [Fact]
    public async Task AttachContentAsync_AReaderAtTheQuota_IsRefusedWithWhatIsStoredUntilTheFileFits()
    {
        var user = await db.NewReaderAsync();
        var stored = await db.NewBookAsync(user);
        await AttachAsync(stored);
        var next = await db.NewBookAsync(user);
        await AttachAsync(await db.NewReaderWithBookAsync()); // another reader's bytes count for them only
        var placed = false;

        var result = await AttachAsync(next, limit: 2047, place: () => placed = true);

        Assert.Equal((AttachOutcome.QuotaExceeded, 1024L), (result.Outcome, result.Used));
        Assert.False(placed);
        Assert.Equal(1024L, await _repo.StoredBytesAsync(user, Ct)); // the unstored file counts nothing
        Assert.Equal(AttachOutcome.Attached, (await AttachAsync(next, limit: 2048)).Outcome);
        Assert.Equal(2048L, await _repo.StoredBytesAsync(user, Ct));
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
    public async Task AttachContentAsync_PlacingTheBytesThrows_RollsBack()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<IOException>(() => AttachAsync(book, place: () => throw new IOException("disk full")));

        Assert.Null(await StoredKeyAsync(book));
    }

    [Fact]
    public async Task AttachContentAsync_AnotherReaderHoldingAlicesIds_CanNeitherStoreNorClearNorCoverHerBook()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var attach = await _repo.AttachContentAsync(bob, alices.Id, alices.CurrentFile!.Id, "library/x.epub", NoLimit, () => { }, Ct);
        Assert.Equal(AttachOutcome.NotFound, attach.Outcome);
        Assert.Null(await StoredKeyAsync(alices));

        await AttachAsync(alices);
        Assert.Null(await _repo.RemoveContentAsync(bob, alices.Id, alices.CurrentFile.Id, Ct));
        Assert.Equal(KeyOf(alices), await StoredKeyAsync(alices));

        Assert.Null(await _repo.SetCoverAsync(bob, alices.Id, "library/cover.png", Ct));
        Assert.Null((await _repo.GetAsync(alices.UserId, alices.Id, Ct))!.CoverKey);
    }

    // "Stop syncing": the first one stamps the file once and moves the feed; a repeat changes nothing.
    // After an attach it did not see, the key it clears is handed back, so the bytes are its to delete (QA probe).
    [Fact]
    public async Task RemoveContentAsync_AReaderStopsSyncing_StampsOnceAndHandsBackTheKeyItCleared()
    {
        var book = await db.NewReaderWithBookAsync();
        Assert.Null(await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct)); // nothing stored
        var first = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.NotNull(first.CurrentFile!.ContentRemovedAt);

        Assert.Null(await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct));
        var again = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((first.UpdatedAt, first.CurrentFile.ContentRemovedAt), (again.UpdatedAt, again.CurrentFile!.ContentRemovedAt));

        await AttachAsync(book);
        Assert.Equal(KeyOf(book), await StoredKeyAsync(book));
        var before = (await _repo.GetAsync(book.UserId, book.Id, Ct))!.UpdatedAt;

        Assert.Equal(KeyOf(book), await _repo.RemoveContentAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct));

        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((string?)null, read.CurrentFile!.ServerStorageKey);
        Assert.NotNull(read.CurrentFile.ContentRemovedAt);
        Assert.True(read.UpdatedAt > before);
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
        Assert.Null(await StoredKeyAsync(book));
    }

    // The book row lock in the attach: a replacement holding it commits first, so the attach answers
    // FileReplaced and never puts bytes on the version it just superseded (QA probe).
    [Fact]
    public async Task AttachContentAsync_ReplacementHoldingTheBookRow_WaitsAndIsFileReplaced()
    {
        var book = await db.NewReaderWithBookAsync();
        var oldFile = book.CurrentFile!;
        await using var tx = await db.DataSource.BeginAsync(Ct);
        Assert.Equal(FileReplaceOutcome.Replaced, (await _repo.ReplaceFileAsync(
            book.UserId, book.Id, NewFile(book.UserId, book.Id), oldFile.Id, tx.Transaction, Ct)).Outcome);

        var placed = false;
        var attach = Task.Run(() => AttachAsync(book, place: () => placed = true), Ct);
        await Task.Delay(500, Ct);
        Assert.False(attach.IsCompleted, "the attach must wait for the book row");
        await tx.CommitAsync(Ct);

        Assert.Equal(AttachOutcome.FileReplaced, (await attach).Outcome);
        Assert.False(placed);
        Assert.Null(await StoredKeyAsync(book, oldFile.Id));
    }

    // #1584: a client caches the cover for a year under its version, so only a new cover moves it, not the book's other writes.
    [Fact]
    public async Task SetCoverAsync_AReaderSetsACoverThenTheTocSyncs_TheCoverVersionMovesOnlyWithTheCover()
    {
        var book = await db.NewReaderWithBookAsync();
        Assert.Null(book.CoverUpdatedAt);

        var covered = (await _repo.SetCoverAsync(book.UserId, book.Id, $"library/{book.UserId}/{book.Id}/cover.jpg", Ct))!;
        Assert.NotNull(covered.CoverUpdatedAt);

        Assert.True(await _repo.SetTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, """[{"label":"One","href":"c1.xhtml"}]""", Ct));
        var afterToc = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.NotEqual(covered.UpdatedAt, afterToc.UpdatedAt);
        Assert.Equal(covered.CoverUpdatedAt, afterToc.CoverUpdatedAt);

        var recovered = (await _repo.SetCoverAsync(book.UserId, book.Id, $"library/{book.UserId}/{book.Id}/cover.png", Ct))!;
        Assert.NotEqual(covered.CoverUpdatedAt, recovered.CoverUpdatedAt);
    }

    // Account delete reads one reader's keys; the orphan sweep reads every reader's.
    [Fact]
    public async Task ListStorageKeysAsync_AReaderWithAStoredFileAndACover_NamesBothAndTheSweepSeesEveryReadersKeys()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);
        var before = (await _repo.GetAsync(book.UserId, book.Id, Ct))!.UpdatedAt;
        var cover = $"library/{Guid.NewGuid()}/cover.png";
        var other = await db.NewReaderWithBookAsync();
        await AttachAsync(other);
        var unstored = await db.NewReaderWithBookAsync();

        var updated = (await _repo.SetCoverAsync(book.UserId, book.Id, cover, Ct))!;

        Assert.Equal((cover, book.CurrentFile!.Id), (updated.CoverKey, updated.CurrentFile!.Id));
        Assert.True(updated.UpdatedAt > before, "a cover moves the book's feed watermark");
        Assert.Equal(new[] { KeyOf(book), cover }.Order(), (await _repo.ListStorageKeysAsync(book.UserId, Ct)).Order());
        var all = await _repo.AllStorageKeysAsync(Ct);
        Assert.Contains(KeyOf(book), all);
        Assert.Contains(cover, all);
        Assert.Contains(KeyOf(other), all);
        Assert.DoesNotContain(KeyOf(unstored), all);
    }

    [Fact]
    public async Task ReplaceFileAsync_AReaderReplacesTheFile_ReleasesAStoredKeyOnlyAndTheQuotaIsExactAtOnce()
    {
        var book = await db.NewReaderWithBookAsync();
        await AttachAsync(book);

        var replaced = await db.ReplaceFileAsync(book);

        Assert.Equal((KeyOf(book), (string?)null), (replaced.ReleasedKey, replaced.Superseded!.ServerStorageKey));
        Assert.Null(await StoredKeyAsync(book));
        Assert.Equal(0L, await _repo.StoredBytesAsync(book.UserId, Ct));
        Assert.Null((await db.ReplaceFileAsync(await db.NewReaderWithBookAsync())).ReleasedKey); // nothing stored, nothing released
    }
}
