using Api.Endpoints;
using Application.ReadingTracking;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace TextStack.UnitTests;

/// <summary>
/// Reading-progress upsert. The endpoint reads then inserts with no concurrency control, and a
/// single reader legitimately fires overlapping PUTs — the 30s session heartbeat, a sendBeacon on
/// unload, an offline-queue flush, a second device. Both see no row, both INSERT, and the loser
/// violated <c>ix_reading_progresses_user_id_site_id_edition_id</c> (23505): a 500 to the client and
/// a silently lost reading position. Sentry caught it on its first day in production.
///
/// These lock the two pure seams the recovery path depends on.
/// </summary>
public class UpsertProgressTests
{
    private static Chapter ChapterAt(int number) => new()
    {
        Id = Guid.NewGuid(),
        EditionId = Guid.NewGuid(),
        ChapterNumber = number,
        Slug = $"chapter-{number}",
        Title = $"Chapter {number}",
        Html = "<p>x</p>",
        PlainText = "x",
    };

    private static ReadingProgress Progress(int? maxChapter, DateTimeOffset? updatedAt = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        EditionId = Guid.NewGuid(),
        ChapterId = Guid.NewGuid(),
        Locator = "epubcfi(/6/2!/4/1)",
        Percent = 0.1,
        MaxChapterNumber = maxChapter,
        UpdatedAt = updatedAt ?? DateTimeOffset.UnixEpoch,
    };

    /// <summary>A write from a current client, which declares its percent unit.</summary>
    private static UpsertProgressRequest Request(Guid chapterId, double percent = 0.5) =>
        new(chapterId, "epubcfi(/6/4!/4/2)", percent, null, ProgressUnit.Book);

    /// <summary>A write from a build that predates the unit contract.</summary>
    private static UpsertProgressRequest LegacyRequest(Guid chapterId, double percent = 0.5) =>
        new(chapterId, "epubcfi(/6/4!/4/2)", percent, null);

    [Fact]
    public void ApplyProgressUpdate_CopiesClientFields()
    {
        var chapter = ChapterAt(3);
        var target = Progress(maxChapter: 1);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(chapter.Id, 0.42), chapter);

        Assert.Equal(chapter.Id, target.ChapterId);
        Assert.Equal(0.42, target.Percent);
        Assert.Equal("epubcfi(/6/4!/4/2)", target.Locator);
    }

    /// <summary>
    /// Editions had no completion field, so four places each answered "is this finished?" with
    /// their own inequality — 0.95 in the shelf service, 0.95 in the web filter, 1.0 on the web
    /// cards, 1.0 in the mobile action sheet — and "mark as read" faked it by writing a percent of
    /// exactly 1. These lock the recorded answer.
    /// </summary>
    [Fact]
    public void ApplyProgressUpdate_PercentAtLeast099_RecordsCompletion()
    {
        var chapter = ChapterAt(40);
        var target = Progress(maxChapter: 39);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(chapter.Id, 0.99), chapter);

        Assert.NotNull(target.CompletedAt);
    }

    [Fact]
    public void ApplyProgressUpdate_RereadingAFinishedBook_DoesNotUnfinishIt()
    {
        var chapter = ChapterAt(1);
        var target = Progress(maxChapter: 40);
        var finishedAt = DateTimeOffset.UtcNow.AddDays(-3);
        target.CompletedAt = finishedAt;

        // Opening chapter 1 again reports a low percent; that is a re-read, not an un-finish.
        UserDataEndpoints.ApplyProgressUpdate(target, Request(chapter.Id, 0.02), chapter);

        Assert.Equal(finishedAt, target.CompletedAt);
    }

    [Fact]
    public void ApplyProgressUpdate_PercentZero_ClearsCompletion()
    {
        var chapter = ChapterAt(1);
        var target = Progress(maxChapter: 40);
        target.CompletedAt = DateTimeOffset.UtcNow.AddDays(-3);

        // Percent 0 is what mark-as-unfinished sends.
        UserDataEndpoints.ApplyProgressUpdate(target, Request(chapter.Id, 0), chapter);

        Assert.Null(target.CompletedAt);
    }

    [Fact]
    public void ApplyProgressUpdate_MidBook_LeavesCompletionUnset()
    {
        var chapter = ChapterAt(5);
        var target = Progress(maxChapter: 4);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(chapter.Id, 0.5), chapter);

        Assert.Null(target.CompletedAt);
    }

    /// <summary>
    /// The high-water mark feeds the RAG spoiler gate, so it must never move backwards — a reader
    /// flipping back to chapter 1 must not re-expose chapter 30 as unread.
    /// </summary>
    [Fact]
    public void ApplyProgressUpdate_EarlierChapter_KeepsHighWaterMark()
    {
        var target = Progress(maxChapter: 30);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(Guid.NewGuid()), ChapterAt(1));

        Assert.Equal(30, target.MaxChapterNumber);
    }

    [Fact]
    public void ApplyProgressUpdate_LaterChapter_RaisesHighWaterMark()
    {
        var target = Progress(maxChapter: 3);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(Guid.NewGuid()), ChapterAt(9));

        Assert.Equal(9, target.MaxChapterNumber);
    }

    /// <summary>NULL means "never recorded" — distinct from ordinal 0, a real 0-based first chapter.</summary>
    [Fact]
    public void ApplyProgressUpdate_NullHighWaterMark_SeedsFromChapter()
    {
        var target = Progress(maxChapter: null);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(Guid.NewGuid()), ChapterAt(0));

        Assert.Equal(0, target.MaxChapterNumber);
    }

    [Fact]
    public void ApplyProgressUpdate_StampsUpdatedAt()
    {
        var before = DateTimeOffset.UtcNow;
        var target = Progress(maxChapter: 1, updatedAt: DateTimeOffset.UnixEpoch);

        UserDataEndpoints.ApplyProgressUpdate(target, Request(Guid.NewGuid()), ChapterAt(1));

        Assert.True(target.UpdatedAt >= before);
    }

    /// <summary>
    /// The recovery path must trigger on a unique violation and NOTHING else — matched on SQLSTATE
    /// so it survives locale changes and constraint renames.
    /// </summary>
    [Fact]
    public void IsUniqueViolation_UniqueViolation_True()
    {
        var ex = new DbUpdateException("save failed", new PostgresException(
            "duplicate key value violates unique constraint", "ERROR", "ERROR",
            PostgresErrorCodes.UniqueViolation));

        Assert.True(UserDataEndpoints.IsUniqueViolation(ex));
    }

    [Fact]
    public void IsUniqueViolation_ForeignKeyViolation_False()
    {
        var ex = new DbUpdateException("save failed", new PostgresException(
            "insert violates foreign key constraint", "ERROR", "ERROR",
            PostgresErrorCodes.ForeignKeyViolation));

        Assert.False(UserDataEndpoints.IsUniqueViolation(ex));
    }

    [Fact]
    public void IsUniqueViolation_NonPostgresInner_False()
    {
        var ex = new DbUpdateException("save failed", new InvalidOperationException("boom"));

        Assert.False(UserDataEndpoints.IsUniqueViolation(ex));
    }

    [Fact]
    public void ApplyProgressUpdate_UndeclaredUnit_KeepsStoredPercentButMovesPosition()
    {
        // An Android build installed before the unit contract goes on writing
        // chapter fractions until its owner updates, and a chapter fraction is
        // indistinguishable from a book fraction by inspection — that is how the
        // same book came to show 10% on the resume card and 32% on the row below.
        //
        // Its position is still the reader's real position, so the locator and the
        // chapter move. Only the number stays as it was.
        var chapter = ChapterAt(3);
        var target = Progress(maxChapter: 1);
        target.Percent = 0.42;
        target.Locator = "old-locator";

        UserDataEndpoints.ApplyProgressUpdate(target, LegacyRequest(chapter.Id, percent: 0.99), chapter);

        Assert.Equal(0.42, target.Percent);
        Assert.Equal("epubcfi(/6/4!/4/2)", target.Locator);
        Assert.Equal(chapter.Id, target.ChapterId);
    }

    [Fact]
    public void ApplyProgressUpdate_UndeclaredUnit_CannotFinishABook()
    {
        // Completion is derived from the percent, so an untrusted number must not
        // be able to mark a book read — a stale client hitting the bottom of a
        // chapter would otherwise finish the whole book.
        var chapter = ChapterAt(3);
        var target = Progress(maxChapter: 1);

        UserDataEndpoints.ApplyProgressUpdate(target, LegacyRequest(chapter.Id, percent: 1.0), chapter);

        Assert.Null(target.CompletedAt);
    }

    // --- PositionJson on the catalog path. Same invariant as uploads: a row never
    // holds two positions that disagree. -----------------------------------------

    private const string Anchor =
        """{"v":1,"chapterSlug":"2-act-i","anchor":{"prefix":"and then ","exact":"the door opened","suffix":" onto a"},"charOffset":4120,"chapterFraction":0.31}""";

    private static UpsertProgressRequest ScrollRequest(Guid chapterId, string? positionJson) =>
        new(chapterId, "scroll:2-act-i:4200", 0.31, null, ProgressUnit.Book, positionJson);

    [Fact]
    public void ApplyProgressUpdate_ScrollWriteWithPosition_StoresIt()
    {
        var chapter = ChapterAt(2);
        var target = Progress(maxChapter: 1);

        UserDataEndpoints.ApplyProgressUpdate(target, ScrollRequest(chapter.Id, Anchor), chapter);

        Assert.Equal(Anchor, target.PositionJson);
    }

    [Fact]
    public void ApplyProgressUpdate_WriteWithoutPosition_ClearsTheStoredOne()
    {
        // The old-build case. A device that predates the column writes the locator and
        // nothing else; its pixel offset is then the only true statement on the row.
        var chapter = ChapterAt(2);
        var target = Progress(maxChapter: 1);
        target.PositionJson = Anchor;

        UserDataEndpoints.ApplyProgressUpdate(target, ScrollRequest(chapter.Id, null), chapter);

        Assert.Equal("scroll:2-act-i:4200", target.Locator);
        Assert.Null(target.PositionJson);
    }

    [Fact]
    public void ApplyProgressUpdate_NonScrollLocator_ClearsThePosition()
    {
        // The catalog path is not guarded by LocatorSpace.MayReplace (ADR-013 records
        // this as a known gap), so a page write or a mark-as-read can land here at any
        // time. Neither has a text anchor, and an anchor left beside one would name a
        // chapter the reader is not in.
        var chapter = ChapterAt(2);
        foreach (var locator in new[] { "page:17", """{"type":"end"}""", "percent:0.42" })
        {
            var target = Progress(maxChapter: 1);
            target.PositionJson = Anchor;

            UserDataEndpoints.ApplyProgressUpdate(
                target, new UpsertProgressRequest(chapter.Id, locator, 0.5, null, ProgressUnit.Book, Anchor), chapter);

            Assert.Null(target.PositionJson);
        }
    }

    [Fact]
    public void ApplyProgressUpdate_OversizedPosition_DropsOnlyThePosition()
    {
        var chapter = ChapterAt(2);
        var target = Progress(maxChapter: 1);

        UserDataEndpoints.ApplyProgressUpdate(
            target, ScrollRequest(chapter.Id, new string('x', ReaderPosition.MaxLength + 1)), chapter);

        Assert.Equal("scroll:2-act-i:4200", target.Locator);
        Assert.Equal(0.31, target.Percent);
        Assert.Null(target.PositionJson);
    }
}
