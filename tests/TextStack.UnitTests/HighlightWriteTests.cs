using Api.Endpoints;
using Domain.Entities;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace TextStack.UnitTests;

/// <summary>
/// Reader audit L2 (the version check was read-check-write, so two writers holding the same version
/// both passed) and L4 (a bad anchor or an over-long colour reached Postgres and answered 500).
/// The update runs on Sqlite through a context that maps only <see cref="Highlight"/>.
/// </summary>
public class HighlightWriteTests
{
    private sealed class Ctx(DbContextOptions<Ctx> options) : DbContext(options)
    {
        public DbSet<Highlight> Highlights => Set<Highlight>();

        protected override void OnModelCreating(ModelBuilder b) => b.Entity<Highlight>(e =>
        {
            e.Ignore(x => x.User); e.Ignore(x => x.Site); e.Ignore(x => x.Edition); e.Ignore(x => x.Chapter);
            e.Ignore(x => x.UserBook); e.Ignore(x => x.UserChapter); e.Ignore(x => x.Note);
        });
    }

    private static readonly Guid UserId = Guid.NewGuid();

    private static (Ctx db, SqliteConnection conn, Guid id) Seed()
    {
        var conn = new SqliteConnection("Filename=:memory:");
        conn.Open();
        var db = new Ctx(new DbContextOptionsBuilder<Ctx>().UseSqlite(conn).Options);
        db.Database.EnsureCreated();
        var h = new Highlight
        {
            Id = Guid.NewGuid(),
            UserId = UserId,
            AnchorJson = "{}",
            Color = "yellow",
            SelectedText = "text",
            NoteText = "note",
            Version = 3,
        };
        db.Highlights.Add(h);
        db.SaveChanges();
        db.ChangeTracker.Clear();
        return (db, conn, h.Id);
    }

    private static UpdateHighlightRequest Req(int? version, string? color = null, bool removeNote = false) =>
        new(color, null, null, null, version, removeNote);

    [Fact]
    public async Task ApplyUpdateAsync_TwoWritersSameVersion_SecondConflicts()
    {
        var (db, conn, id) = Seed();
        using var _ = conn;
        var ct = TestContext.Current.CancellationToken;

        var first = await HighlightsEndpoints.ApplyUpdateAsync(db.Highlights, id, UserId, Req(3, "green"), DateTimeOffset.UtcNow, ct);
        var second = await HighlightsEndpoints.ApplyUpdateAsync(db.Highlights, id, UserId, Req(3, "blue"), DateTimeOffset.UtcNow, ct);

        Assert.Equal(1, first);
        Assert.Equal(0, second);
        var row = await db.Highlights.AsNoTracking().SingleAsync(ct);
        Assert.Equal(("green", 4), (row.Color, row.Version));
    }

    [Fact]
    public async Task ApplyUpdateAsync_NoVersion_LastWriteWinsAndKeepsUnsentFields()
    {
        var (db, conn, id) = Seed();
        using var _ = conn;
        var ct = TestContext.Current.CancellationToken;

        Assert.Equal(1, await HighlightsEndpoints.ApplyUpdateAsync(db.Highlights, id, UserId, Req(null, "blue"), DateTimeOffset.UtcNow, ct));

        var row = await db.Highlights.AsNoTracking().SingleAsync(ct);
        Assert.Equal(("blue", "note", "text", 4), (row.Color, row.NoteText, row.SelectedText, row.Version));
    }

    [Fact]
    public async Task ApplyUpdateAsync_RemoveNote_ClearsNote()
    {
        var (db, conn, id) = Seed();
        using var _ = conn;
        var ct = TestContext.Current.CancellationToken;

        await HighlightsEndpoints.ApplyUpdateAsync(db.Highlights, id, UserId, Req(3, removeNote: true), DateTimeOffset.UtcNow, ct);

        Assert.Null((await db.Highlights.AsNoTracking().SingleAsync(ct)).NoteText);
    }

    [Fact]
    public async Task ApplyUpdateAsync_OtherUser_WritesNothing()
    {
        var (db, conn, id) = Seed();
        using var _ = conn;

        Assert.Equal(0, await HighlightsEndpoints.ApplyUpdateAsync(
            db.Highlights, id, Guid.NewGuid(), Req(null, "blue"), DateTimeOffset.UtcNow, TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("yellow", "{\"exact\":\"x\"}", "x", true, null)]
    [InlineData(null, "{}", "x", true, "Color required")]
    [InlineData("   ", "{}", "x", false, "Color required")]
    [InlineData("a-colour-name-longer-than-20", "{}", "x", true, "Color too long (max 20 chars)")]
    [InlineData("yellow", null, "x", true, "AnchorJson required")]
    [InlineData("yellow", "not json", "x", true, "AnchorJson must be valid JSON")]
    [InlineData("yellow", "[1,2]", "x", true, "AnchorJson must be a JSON object")]
    [InlineData("yellow", "{}", null, true, "SelectedText required")]
    [InlineData(null, null, null, false, null)]
    public void ValidateFields_Inputs_ExpectedError(
        string? color, string? anchor, string? text, bool required, string? expected)
    {
        Assert.Equal(expected, HighlightsEndpoints.ValidateFields(color, anchor, text, required));
    }
}
