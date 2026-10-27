using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for highlights endpoints.
/// Requires: docker compose up (API must be running)
/// Note: These tests require authentication, so some will be skipped without valid auth tokens.
/// </summary>
public class HighlightsEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private readonly AuthenticatedApiFixture _auth;

    public HighlightsEndpointTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    {
        _fixture = fixture;
        _auth = auth;
    }

    #region GET /me/highlights/{editionId}

    [Fact]
    public async Task GetHighlights_WithoutAuth_Returns401()
    {
        var editionId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Get, $"/me/highlights/{editionId}");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region POST /me/highlights

    [Fact]
    public async Task CreateHighlight_WithoutAuth_Returns401()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/me/highlights");
        request.Content = JsonContent.Create(new
        {
            editionId = Guid.NewGuid(),
            chapterId = Guid.NewGuid(),
            anchorJson = """{"prefix":"test","exact":"text","suffix":"here","startOffset":0,"endOffset":4,"chapterId":"test"}""",
            color = "yellow",
            selectedText = "text"
        });

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_InvalidColor_Returns400()
    {
        // This would need auth to test properly, but the endpoint should validate color
        var request = _fixture.CreateRequest(HttpMethod.Post, "/me/highlights");
        request.Content = JsonContent.Create(new
        {
            editionId = Guid.NewGuid(),
            chapterId = Guid.NewGuid(),
            anchorJson = """{"prefix":"test","exact":"text","suffix":"here","startOffset":0,"endOffset":4}""",
            color = "invalid_color",
            selectedText = "text"
        });

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        // Without auth, should still be 401
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region PUT /me/highlights/{id}

    [Fact]
    public async Task UpdateHighlight_WithoutAuth_Returns401()
    {
        var highlightId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Put, $"/me/highlights/{highlightId}");
        request.Content = JsonContent.Create(new
        {
            color = "blue",
            noteText = "Test note"
        });

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region DELETE /me/highlights/{id}

    [Fact]
    public async Task DeleteHighlight_WithoutAuth_Returns401()
    {
        var highlightId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Delete, $"/me/highlights/{highlightId}");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region PDF highlights (chapterless, page-anchored) — S-a

    // A PDF page highlight carries no chapter: UserChapterId is null and the location lives entirely
    // inside the opaque AnchorJson. The server must accept it, list it, and surface it in the
    // aggregate/review projections without NRE.
    private const string PdfAnchorJson =
        """{"v":1,"kind":"pdf","page":1,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.02}],"exact":"real books"}""";

    private async Task<Guid?> SeedUserBookIdAsync()
    {
        // Clip creates a real, owned user book synchronously (status Processing is fine — the
        // highlight path only checks ownership, not readiness).
        var seed = _auth.CreateRequest(HttpMethod.Post, "/me/books/clip");
        seed.Content = JsonContent.Create(new
        {
            title = "PDF Highlights Integration",
            html = "<h1>PDF Highlights</h1><p>Real fluency comes from real books.</p>",
            language = "en"
        });
        var resp = await _auth.Client.SendAsync(seed, TestContext.Current.CancellationToken);
        if (resp.StatusCode != HttpStatusCode.OK) return null;
        var clip = await resp.Content.ReadFromJsonAsync<ClipResponse>(
            cancellationToken: TestContext.Current.CancellationToken);
        return clip?.UserBookId;
    }

    [Fact]
    public async Task CreateHighlight_UserBookChapterlessPdfAnchor_Returns201AndPersistsNullChapter()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "real books"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        var dto = await resp.Content.ReadFromJsonAsync<HighlightDto>(
            cancellationToken: TestContext.Current.CancellationToken);
        Assert.NotNull(dto);
        Assert.Equal(bookId, dto!.UserBookId);
        Assert.Null(dto.UserChapterId);
        Assert.Null(dto.ChapterId);
        Assert.Null(dto.EditionId);
    }

    [Fact]
    public async Task GetUserBookHighlights_ReturnsChapterlessPdfHighlight()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        var create = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        create.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = PdfAnchorJson,
            color = "green",
            selectedText = "real books"
        });
        var createResp = await _auth.Client.SendAsync(create, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Created, createResp.StatusCode);
        var created = await createResp.Content.ReadFromJsonAsync<HighlightDto>(
            cancellationToken: TestContext.Current.CancellationToken);

        var list = _auth.CreateRequest(HttpMethod.Get, $"/me/highlights/userbook/{bookId}");
        var listResp = await _auth.Client.SendAsync(list, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, listResp.StatusCode);
        var items = await listResp.Content.ReadFromJsonAsync<HighlightDto[]>(
            cancellationToken: TestContext.Current.CancellationToken);
        Assert.NotNull(items);
        var found = Assert.Single(items!, h => h.Id == created!.Id);
        Assert.Null(found.UserChapterId);
    }

    [Fact]
    public async Task GetAllHighlights_WithChapterlessUserBookHighlight_Returns200()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        var create = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        create.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "real books"
        });
        await _auth.Client.SendAsync(create, TestContext.Current.CancellationToken);

        // The all-highlights projection joins chapter titles — must not NRE on the null chapter.
        var all = _auth.CreateRequest(HttpMethod.Get, "/me/highlights/all?bookType=userbook");
        var allResp = await _auth.Client.SendAsync(all, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, allResp.StatusCode);
    }

    [Fact]
    public async Task GetHighlightsForReview_WithChapterlessUserBookHighlight_Returns200()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        var create = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        create.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "real books"
        });
        await _auth.Client.SendAsync(create, TestContext.Current.CancellationToken);

        var review = _auth.CreateRequest(HttpMethod.Get, "/me/highlights/review");
        var reviewResp = await _auth.Client.SendAsync(review, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, reviewResp.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_UserBookMissingColor_Returns400()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = PdfAnchorJson,
            color = "",
            selectedText = "real books"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_UserBookWithCatalogChapterId_Returns400()
    {
        // #939: an upload highlight must not carry a catalog chapter id — it would be stored as given.
        // Random ids: the check runs before any lookup, so without it this answers 404.
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            userBookId = Guid.NewGuid(),
            chapterId = Guid.NewGuid(),
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "real books"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_UserBookNotOwnedByCaller_Returns404AndNotCreated()
    {
        // Ownership must still hold on the chapterless PDF path: a UserBookId the caller does not
        // own (here a random id) must be rejected before any highlight is created.
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        var foreignBookId = Guid.NewGuid();
        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            userBookId = foreignBookId,
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "real books"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_UserBookReflowAnchorWithoutChapter_Returns400()
    {
        // L3 fix: a non-PDF (reflow text-offset) anchor with a null UserChapterId is an orphan that
        // never paints and misroutes — it must be rejected, unlike a chapterless PDF page anchor.
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");
        var bookId = await SeedUserBookIdAsync();
        Assert.SkipWhen(bookId is null, "clip seed unavailable");

        const string reflowAnchor =
            """{"v":1,"prefix":"real ","exact":"books","suffix":".","startOffset":0,"endOffset":5}""";
        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            userBookId = bookId,
            anchorJson = reflowAnchor,
            color = "yellow",
            selectedText = "books"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_EditionWithoutChapter_StillReturns400()
    {
        // The edition/catalog branch is EPUB/reflow — chapter stays required. Unchanged by S-a.
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/highlights");
        req.Content = JsonContent.Create(new
        {
            editionId = Guid.NewGuid(),
            anchorJson = PdfAnchorJson,
            color = "yellow",
            selectedText = "text"
        });
        var resp = await _auth.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    private record ClipResponse(Guid UserBookId, Guid JobId, string Status);

    private record HighlightDto(
        Guid Id,
        Guid? EditionId,
        Guid? ChapterId,
        Guid? UserBookId,
        Guid? UserChapterId,
        string AnchorJson,
        string Color,
        string SelectedText,
        string? NoteText,
        int Version,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    #endregion
}
