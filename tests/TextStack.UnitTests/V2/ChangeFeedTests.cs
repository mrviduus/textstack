using Application.Sync;
using Contracts.V2;

namespace TextStack.UnitTests.V2;

/// <summary>The feed cursor of v2-sync-protocol.md "Pull and push": exact inside a pull, rewound by the overlap across pulls.</summary>
public class ChangeFeedTests
{
    private sealed record Row(DateTimeOffset UpdatedAt, Guid Id);

    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    private static readonly Row[] Rows = [.. Enumerable.Range(0, 5).Select(i => new Row(T0.AddSeconds(i), Guid.NewGuid()))];

    /// <summary>A feed over <see cref="Rows"/> that remembers where each read started.</summary>
    private sealed class Feed(Row[] rows)
    {
        public (DateTimeOffset Since, Guid AfterId) LastRead;

        public Feed() : this(Rows) { }

        public Task<SyncResult> PageAsync(string? cursor, int? limit) =>
            ChangeFeed.PageAsync<Row, Row>(cursor, limit, (since, afterId, take) =>
            {
                LastRead = (since, afterId);
                return Task.FromResult<IReadOnlyList<Row>>(rows.Where(r => (r.UpdatedAt, r.Id).CompareTo((since, afterId)) > 0).Take(take).ToList());
            }, r => (r.UpdatedAt, r.Id), r => r);
    }

    private static ChangeFeedDto<Row> Page(SyncResult result) => Assert.IsType<ChangeFeedDto<Row>>(result.Body);

    [Fact]
    public async Task PageAsync_NoCursor_ReadsFromTheBeginning()
    {
        var feed = new Feed();

        var page = Page(await feed.PageAsync(null, 2));

        Assert.Equal((DateTimeOffset.UnixEpoch, Guid.Empty), feed.LastRead);
        Assert.Equal((2, true), (page.Items.Count, page.HasMore));
    }

    [Fact]
    public async Task PageAsync_CursorOfAPageWithMore_ContinuesExactlyAfterItsLastRow()
    {
        var feed = new Feed();
        var first = Page(await feed.PageAsync(null, 2));

        var second = Page(await feed.PageAsync(first.Cursor, 2));

        Assert.Equal((Rows[1].UpdatedAt, Rows[1].Id), feed.LastRead);
        Assert.Equal([Rows[2], Rows[3]], second.Items);
    }

    [Fact]
    public async Task PageAsync_CursorOfTheLastPage_ResumesFromItsWatermarkMinusTheOverlap()
    {
        var feed = new Feed();
        var last = Page(await feed.PageAsync(null, 10));
        Assert.False(last.HasMore);

        await feed.PageAsync(last.Cursor, 10);

        // A write that took now() before the last row seen but committed after it is still delivered.
        Assert.Equal((Rows[^1].UpdatedAt - ChangeFeed.Overlap, Guid.Empty), feed.LastRead);
    }

    [Fact]
    public async Task PageAsync_NothingNew_KeepsTheCallersCursor()
    {
        var cursor = Page(await new Feed().PageAsync(null, 10)).Cursor;

        var nothing = Page(await new Feed([]).PageAsync(cursor, 10));

        Assert.Equal((cursor, 0, false), (nothing.Cursor, nothing.Items.Count, nothing.HasMore));
        Assert.Null(Page(await new Feed([]).PageAsync(null, 10)).Cursor);
    }

    [Theory]
    [InlineData("not a cursor")]
    [InlineData("eDox")] // base64 of "x:1"
    public async Task PageAsync_ForeignCursor_IsInvalidPayload(string cursor) =>
        Assert.Equal("cursor", Assert.IsType<V2Error>((await new Feed().PageAsync(cursor, null)).Body).Field);

    [Theory]
    [InlineData(0)]
    [InlineData(501)]
    public async Task PageAsync_LimitOutsideOneTo500_IsInvalidPayload(int limit) =>
        Assert.Equal("limit", Assert.IsType<V2Error>((await new Feed().PageAsync(null, limit)).Body).Field);
}
