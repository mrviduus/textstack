using System.Text.Json;
using Api.Endpoints;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.AspNetCore.Http;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// <c>GET /me/library</c> and <c>GET /me/progress</c> are the reader's own rows, and no client pages
/// them — web, mobile and shared all call them bare. A default page of 50 silently dropped book 51.
/// </summary>
public class OwnListLimitTests
{
    private static readonly Guid UserId = Guid.NewGuid();

    private static HttpContext Ctx()
    {
        var ctx = new DefaultHttpContext();
        ctx.Items[Api.Middleware.McpKeyAuthMiddleware.UserIdItemKey] = UserId;
        return ctx;
    }

    private static (Mock<IAppDbContext> Db, int Count) Seed(int count)
    {
        var editions = new List<Edition>();
        var chapters = new List<Chapter>();
        var library = new List<UserLibrary>();
        var progress = new List<ReadingProgress>();
        for (var i = 0; i < count; i++)
        {
            var e = new Edition { Id = Guid.NewGuid(), Language = "en", Slug = $"b{i}", Title = $"B{i}" };
            var c = new Chapter { Id = Guid.NewGuid(), EditionId = e.Id, Slug = "c", Title = "C", Html = "", PlainText = "" };
            editions.Add(e);
            chapters.Add(c);
            library.Add(new UserLibrary { Id = Guid.NewGuid(), UserId = UserId, EditionId = e.Id, Edition = e, CreatedAt = DateTimeOffset.UnixEpoch.AddDays(i) });
            progress.Add(new ReadingProgress { Id = Guid.NewGuid(), UserId = UserId, EditionId = e.Id, ChapterId = c.Id, Locator = "x", UpdatedAt = DateTimeOffset.UnixEpoch.AddDays(i) });
        }
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.UserLibraries).Returns(new FakeDbSet<UserLibrary>(library));
        db.Setup(x => x.ReadingProgresses).Returns(new FakeDbSet<ReadingProgress>(progress));
        db.Setup(x => x.Chapters).Returns(new FakeDbSet<Chapter>(chapters));
        return (db, count);
    }

    private static int ItemCount(IResult result)
    {
        var json = JsonSerializer.SerializeToElement(((IValueHttpResult)result).Value);
        return json.GetProperty("items").GetArrayLength();
    }

    [Fact]
    public async Task GetLibrary_NoLimit_Returns120Of120()
    {
        var (db, n) = Seed(120);
        var result = await UserDataEndpoints.GetLibrary(Ctx(), null!, db.Object, null, null, CancellationToken.None);
        Assert.Equal(n, ItemCount(result));
    }

    [Fact]
    public async Task GetAllProgress_NoLimit_Returns120Of120()
    {
        var (db, n) = Seed(120);
        var result = await UserDataEndpoints.GetAllProgress(Ctx(), null!, db.Object, null, null, CancellationToken.None);
        Assert.Equal(n, ItemCount(result));
    }

    [Fact]
    public async Task GetLibrary_ExplicitLimitAndOffset_StillPages()
    {
        var (db, _) = Seed(10);
        var result = await UserDataEndpoints.GetLibrary(Ctx(), null!, db.Object, 3, 8, CancellationToken.None);
        Assert.Equal(2, ItemCount(result));
    }

    [Fact]
    public async Task GetAllProgress_NegativeLimitAndOffset_ReturnsWholeList()
    {
        var (db, _) = Seed(10);
        var result = await UserDataEndpoints.GetAllProgress(Ctx(), null!, db.Object, -5, -1, CancellationToken.None);
        Assert.Equal(10, ItemCount(result));
    }
}
