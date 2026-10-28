using Application.Ingestion;
using Domain;
using Domain.Entities;
using Infrastructure.Persistence.Repositories;
using Microsoft.EntityFrameworkCore;

namespace TextStack.Persistence.Tests;

/// <summary>
/// Re-ingestion end to end on real Postgres: EF rewrites the chapters and Dapper moves the insights,
/// in ONE transaction (ADR-028 §4). Slug-move rules themselves: ChapterPositionRemapTests (unit).
/// </summary>
public class ReconcilerInsightMoveTests(PostgresFixture db)
{
    private readonly InsightRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static UserChapter Chapter(Guid bookId, int number, string title) => new()
    {
        Id = Guid.NewGuid(),
        UserBookId = bookId,
        ChapterNumber = number,
        Slug = $"{number}-{title.ToLowerInvariant()}",
        Title = title,
        Html = "<p>x</p>",
        PlainText = title + " text",
        CreatedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public async Task ReconcileUserBook_ChapterAddedInFront_InsightFollowsItsChapter()
    {
        var (user, bookId) = await db.NewReaderWithBookAsync();
        await using (var seed = db.NewDbContext())
        {
            seed.UserChapters.AddRange(Chapter(bookId, 1, "Alpha"), Chapter(bookId, 2, "Beta"));
            await seed.SaveChangesAsync(Ct);
        }
        var now = DateTimeOffset.UtcNow;
        var insight = (await _repo.SaveAsync(new BookInsight
        {
            Id = Guid.NewGuid(),
            UserId = user,
            SiteId = SiteConstants.DefaultSiteId,
            UserBookId = bookId,
            ChapterSlug = "2-beta",
            Text = "about Beta",
            CreatedAt = now,
            UpdatedAt = now,
        }, Ct))!;

        // The extractor now finds a preface: every slug shifts; Beta is matched by title.
        await using var ef = db.NewDbContext();
        var book = await ef.UserBooks.SingleAsync(b => b.Id == bookId, Ct);
        await ChapterReconciler.ReconcileUserBookAsync(ef, _repo, book,
            [Chapter(bookId, 1, "Preface"), Chapter(bookId, 2, "Alpha"), Chapter(bookId, 3, "Beta")], Ct);

        var row = Assert.Single(await _repo.ListForBookAsync(user, bookId, null, Ct));
        Assert.Equal((insight.Id, "3-beta"), (row.Id, row.ChapterSlug));
    }
}
