using Domain.Library;
using Domain.Transitional;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Transitional;

public class BookChapterRepositoryTests(V2PostgresFixture db)
{
    private readonly BookChapterRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static BookChapter Chapter(string key, int number) => new()
    {
        Id = Guid.NewGuid(),
        ChapterKey = key,
        ChapterNumber = number,
        Title = "Title " + key,
        Html = $"<p>{key}</p>",
        PlainText = "text of " + key,
        WordCount = 3,
    };

    /// <summary>A book whose current file has chapters "one", "two", "four", numbered 1, 2, 4 and stored out of order.</summary>
    private async Task<Book> BookWithChaptersAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.ReplaceForFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, [Chapter("four", 4), Chapter("one", 1), Chapter("two", 2)], Ct);
        return book;
    }

    [Fact]
    public async Task ReplaceForFileAsync_Chapters_ListTocInReadingOrder()
    {
        var book = await BookWithChaptersAsync();

        var toc = await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);

        Assert.Equal(["one", "two", "four"], toc.Select(c => c.ChapterKey));
        Assert.Equal("Title one", toc[0].Title);
    }

    [Fact]
    public async Task ReplaceForFileAsync_SecondExtraction_ReplacesTheFirstsChapters()
    {
        var book = await BookWithChaptersAsync();

        await _repo.ReplaceForFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, [Chapter("one", 1), Chapter("five", 2)], Ct);

        var toc = await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);
        Assert.Equal(["one", "five"], toc.Select(c => c.ChapterKey));
    }

    [Fact]
    public async Task ReplaceForFileAsync_AnotherVersionsChapters_AreKept()
    {
        var book = await BookWithChaptersAsync();
        var replaced = await db.ReplaceFileAsync(book);

        await _repo.ReplaceForFileAsync(book.UserId, book.Id, replaced.Current!.Id, [Chapter("new", 1)], Ct);

        Assert.Equal(3, (await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct)).Count);
        Assert.Single(await _repo.ListTocAsync(book.UserId, book.Id, replaced.Current.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForFileAsync_FailedReplacement_KeepsTheOldChapters()
    {
        var book = await BookWithChaptersAsync();

        await Assert.ThrowsAsync<PostgresException>(() =>
            _repo.ReplaceForFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, [Chapter("dup", 1), Chapter("dup", 2)], Ct));

        Assert.Equal(3, (await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct)).Count);
    }

    [Fact]
    public async Task ListTocAsync_ZeroBasedSparseNumbersInsertedOutOfOrder_ComeInNumberOrder()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.ReplaceForFileAsync(book.UserId, book.Id, book.CurrentFile!.Id,
            [Chapter("ten", 10), Chapter("zero", 0), Chapter("hundred", 100), Chapter("two", 2)], Ct);

        var toc = await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);

        Assert.Equal(["zero", "two", "ten", "hundred"], toc.Select(c => c.ChapterKey));
    }

    [Fact]
    public async Task ReplaceForFileAsync_DuplicateKey_StoresNone()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<PostgresException>(() =>
            _repo.ReplaceForFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, [Chapter("one", 1), Chapter("one", 2)], Ct));

        Assert.Empty(await _repo.ListTocAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForFileAsync_AnotherUsersFile_IsRefusedByTheFk()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var error = await Assert.ThrowsAsync<PostgresException>(() =>
            _repo.ReplaceForFileAsync(bob, alices.Id, alices.CurrentFile!.Id, [Chapter("one", 1)], Ct));

        Assert.Equal("23503", error.SqlState);
    }

    [Fact]
    public async Task ListTocAsync_Bob_SeesNoneOfAlicesChapters()
    {
        var book = await BookWithChaptersAsync();

        Assert.Empty(await _repo.ListTocAsync(await db.NewReaderAsync(), book.Id, book.CurrentFile!.Id, Ct));
    }

    [Fact]
    public async Task GetAsync_Key_ReturnsTheWholeChapter()
    {
        var book = await BookWithChaptersAsync();

        var chapter = (await _repo.GetAsync(book.UserId, book.CurrentFile!.Id, "two", Ct))!;

        Assert.Equal((2, "<p>two</p>", "text of two", book.Id), (chapter.ChapterNumber, chapter.Html, chapter.PlainText, chapter.BookId));
    }

    [Fact]
    public async Task GetAsync_Bob_ReturnsNull()
    {
        var book = await BookWithChaptersAsync();

        Assert.Null(await _repo.GetAsync(await db.NewReaderAsync(), book.CurrentFile!.Id, "two", Ct));
    }

    [Fact]
    public async Task GetNeighboursAsync_GapInTheNumbering_SkipsIt()
    {
        var book = await BookWithChaptersAsync();

        var (previous, next) = await _repo.GetNeighboursAsync(book.UserId, book.Id, book.CurrentFile!.Id, "four", Ct);

        Assert.Equal(("two", (string?)null), (previous?.ChapterKey, next?.ChapterKey));
    }

    [Fact]
    public async Task GetNeighboursAsync_FirstChapter_HasOnlyANext()
    {
        var book = await BookWithChaptersAsync();

        var (previous, next) = await _repo.GetNeighboursAsync(book.UserId, book.Id, book.CurrentFile!.Id, "one", Ct);

        Assert.Equal(((string?)null, "two"), (previous?.ChapterKey, next?.ChapterKey));
    }

    [Fact]
    public async Task GetNeighboursAsync_Bob_FindsNeither()
    {
        var book = await BookWithChaptersAsync();

        Assert.Equal((null, null), await _repo.GetNeighboursAsync(await db.NewReaderAsync(), book.Id, book.CurrentFile!.Id, "two", Ct));
    }

    [Fact]
    public async Task GetPlainTextAsync_Key_ReturnsTheText()
    {
        var book = await BookWithChaptersAsync();

        Assert.Equal("text of one", await _repo.GetPlainTextAsync(book.UserId, book.CurrentFile!.Id, "one", Ct));
    }

    [Fact]
    public async Task GetPlainTextAsync_Bob_ReturnsNull()
    {
        var book = await BookWithChaptersAsync();

        Assert.Null(await _repo.GetPlainTextAsync(await db.NewReaderAsync(), book.CurrentFile!.Id, "one", Ct));
    }
}
