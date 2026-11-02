using Application.Sync;
using Contracts.V2;

namespace TextStack.UnitTests.V2;

/// <summary>
/// The feed cursor of v2-sync-protocol.md "Pull and push": the last row sent, or — at the end of a
/// pull whose last row is younger than the overlap — pull time minus the overlap; read from exactly after.
/// </summary>
public class ChangeFeedTests
{
    private sealed record Row(DateTimeOffset UpdatedAt, Guid Id);

    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    private static readonly Row[] Rows = [.. Enumerable.Range(0, 5).Select(i => new Row(T0.AddSeconds(i), Guid.NewGuid()))];

    /// <summary>A feed over some rows that remembers where each read started.</summary>
    private sealed class Feed(Row[] rows)
    {
        public (DateTimeOffset Since, Guid AfterId) LastRead;

        /// <summary>When the pull runs: by default the rows are seconds old, inside the overlap.</summary>
        public DateTimeOffset Now = T0.AddSeconds(10);

        public Feed() : this(Rows) { }

        public Task<SyncResult> PageAsync(string? cursor, string? limit) =>
            ChangeFeed.PageAsync<Row, Row>(cursor, limit, (since, afterId, take) =>
            {
                LastRead = (since, afterId);
                return Task.FromResult<IReadOnlyList<Row>>(rows.Where(r => (r.UpdatedAt, r.Id).CompareTo((since, afterId)) > 0).Take(take).ToList());
            }, r => (r.UpdatedAt, r.Id), r => r, Now);
    }

    private static ChangeFeedDto<Row> Page(SyncResult result) => Assert.IsType<ChangeFeedDto<Row>>(result.Body);

    [Fact]
    public async Task PageAsync_NoCursor_ReadsFromTheBeginning()
    {
        var feed = new Feed();

        var page = Page(await feed.PageAsync(null, "2"));

        Assert.Equal((DateTimeOffset.UnixEpoch, Guid.Empty), feed.LastRead);
        Assert.Equal((2, true), (page.Items.Count, page.HasMore));
    }

    [Fact]
    public async Task PageAsync_CursorOfAPageWithMore_ContinuesExactlyAfterItsLastRow()
    {
        var feed = new Feed();
        var first = Page(await feed.PageAsync(null, "2"));

        var second = Page(await feed.PageAsync(first.Cursor, "2"));

        Assert.Equal((Rows[1].UpdatedAt, Rows[1].Id), feed.LastRead);
        Assert.Equal([Rows[2], Rows[3]], second.Items);
    }

    [Fact]
    public async Task PageAsync_LastPageYoungerThanTheOverlap_ResumesFromPullTimeMinusTheOverlap()
    {
        var feed = new Feed();
        var last = Page(await feed.PageAsync(null, "10"));
        Assert.False(last.HasMore);

        await feed.PageAsync(last.Cursor, "10");

        // A write that took now() before the last row seen but committed after it is still delivered.
        Assert.Equal((feed.Now - ChangeFeed.Overlap, Guid.Empty), feed.LastRead);
    }

    [Fact]
    public async Task PageAsync_LastPageOlderThanTheOverlap_ResumesExactlyAfterItsLastRow()
    {
        var feed = new Feed { Now = Rows[^1].UpdatedAt + ChangeFeed.Overlap + TimeSpan.FromSeconds(1) };
        var last = Page(await feed.PageAsync(null, "10"));

        var poll = Page(await feed.PageAsync(last.Cursor, "10"));

        // Nothing can still commit before it, so the next poll re-delivers nothing.
        Assert.Equal((Rows[^1].UpdatedAt, Rows[^1].Id), feed.LastRead);
        Assert.Empty(poll.Items);
    }

    [Fact]
    public async Task PageAsync_BatchSharingOneUpdatedAtLargerThanTheLimit_IsPulledOnceToTheEnd()
    {
        var batch = Enumerable.Range(0, 5).Select(_ => new Row(T0, Guid.NewGuid())).OrderBy(r => r.Id).ToArray();
        var feed = new Feed(batch) { Now = T0 + ChangeFeed.Overlap + TimeSpan.FromMinutes(1) };

        var seen = new List<Row>();
        string? cursor = null;
        for (var i = 0; i < 10; i++)
        {
            var page = Page(await feed.PageAsync(cursor, "2"));
            seen.AddRange(page.Items);
            cursor = page.Cursor;
            if (!page.HasMore) break;
        }

        Assert.Equal(batch, seen);
        Assert.Empty(Page(await feed.PageAsync(cursor, "2")).Items);
    }

    [Fact]
    public async Task PageAsync_EmptyCursorAndLimit_AreAFullPullOfTheDefaultSize()
    {
        var feed = new Feed();

        Assert.Equal(5, Page(await feed.PageAsync("", "")).Items.Count);
        Assert.Equal((DateTimeOffset.UnixEpoch, Guid.Empty), feed.LastRead);
    }

    [Fact]
    public async Task PageAsync_NothingNew_KeepsTheCallersCursor()
    {
        var cursor = Page(await new Feed().PageAsync(null, "10")).Cursor;

        var nothing = Page(await new Feed([]).PageAsync(cursor, "10"));

        Assert.Equal((cursor, 0, false), (nothing.Cursor, nothing.Items.Count, nothing.HasMore));
        Assert.Null(Page(await new Feed([]).PageAsync(null, "10")).Cursor);
    }

    [Theory]
    [InlineData("not a cursor")]
    [InlineData("eDox")] // base64 of "x:1"
    public async Task PageAsync_ForeignCursor_IsInvalidPayload(string cursor) =>
        Assert.Equal("cursor", V2Fakes.Error(await new Feed().PageAsync(cursor, null)).Field);

    [Theory]
    [InlineData("0")]
    [InlineData("501")]
    [InlineData("-1")]
    [InlineData("ten")]
    public async Task PageAsync_LimitOutsideOneTo500_IsInvalidPayload(string limit) =>
        Assert.Equal("limit", V2Fakes.Error(await new Feed().PageAsync(null, limit)).Field);
}
