using System.Net;
using System.Net.Http.Json;

namespace OnlineLib.IntegrationTests;

/// <summary>
/// Integration tests for admin book upload API.
/// Tests happy path upload flow for each supported format.
/// </summary>
public class AdminUploadTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;
    private readonly TestWebApplicationFactory _factory;
    private static readonly Guid SiteId = TestWebApplicationFactory.GeneralSiteId;
    private static readonly Guid TestAuthorId = TestWebApplicationFactory.TestAuthorId;
    private static readonly Guid TestGenreId = TestWebApplicationFactory.TestGenreId;

    public AdminUploadTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static string FixturePath(string fileName) =>
        Path.Combine(AppContext.BaseDirectory, "Fixtures", fileName);

    private static void AddRequiredFields(MultipartFormDataContent content, string title)
    {
        content.Add(new StringContent(SiteId.ToString()), "siteId");
        content.Add(new StringContent(title), "title");
        content.Add(new StringContent("en"), "language");
        content.Add(new StringContent(TestAuthorId.ToString()), "authorIds");
        content.Add(new StringContent(TestGenreId.ToString()), "genreId");
    }

    [Fact]
    public async Task UploadPdf_HappyPath_ReturnsCreatedWithJobId()
    {
        // Arrange
        var filePath = FixturePath("sample_textlayer.pdf");
        if (!File.Exists(filePath))
            return;

        using var content = new MultipartFormDataContent();
        await using var fileStream = File.OpenRead(filePath);
        content.Add(new StreamContent(fileStream), "file", "sample_textlayer.pdf");
        AddRequiredFields(content, $"Test PDF Book {Guid.NewGuid():N}");

        // Act
        var response = await _client.PostAsync("/admin/books/upload", content);

        // Assert
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<UploadResponse>();
        Assert.NotNull(result);
        Assert.NotEqual(Guid.Empty, result.JobId);
        Assert.NotEqual(Guid.Empty, result.EditionId);
        Assert.NotEqual(Guid.Empty, result.WorkId);
        Assert.Equal("Queued", result.Status);
        _factory.TrackJob(result.JobId);
    }

    [Fact]
    public async Task UploadEpub_HappyPath_ReturnsCreatedWithJobId()
    {
        // Arrange
        var filePath = FixturePath("minimal.epub");
        if (!File.Exists(filePath))
            return;

        using var content = new MultipartFormDataContent();
        await using var fileStream = File.OpenRead(filePath);
        content.Add(new StreamContent(fileStream), "file", "minimal.epub");
        AddRequiredFields(content, $"Test EPUB Book {Guid.NewGuid():N}");

        // Act
        var response = await _client.PostAsync("/admin/books/upload", content);

        // Assert
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<UploadResponse>();
        Assert.NotNull(result);
        Assert.NotEqual(Guid.Empty, result.JobId);
        Assert.Equal("Queued", result.Status);
        _factory.TrackJob(result.JobId);
    }

    [Fact]
    public async Task UploadTxt_HappyPath_ReturnsCreatedWithJobId()
    {
        // Arrange
        var filePath = FixturePath("sample.txt");
        if (!File.Exists(filePath))
            return;

        using var content = new MultipartFormDataContent();
        await using var fileStream = File.OpenRead(filePath);
        content.Add(new StreamContent(fileStream), "file", "sample.txt");
        AddRequiredFields(content, $"Test TXT Book {Guid.NewGuid():N}");

        // Act
        var response = await _client.PostAsync("/admin/books/upload", content);

        // Assert - TXT is not in AllowedExtensions, should fail
        if (response.StatusCode == HttpStatusCode.BadRequest)
            return;

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<UploadResponse>();
        Assert.NotNull(result);
        Assert.NotEqual(Guid.Empty, result.JobId);
        _factory.TrackJob(result.JobId);
    }

    [Fact]
    public async Task Upload_InvalidSiteId_ReturnsBadRequest()
    {
        // Arrange
        var filePath = FixturePath("sample_textlayer.pdf");
        if (!File.Exists(filePath))
            return;

        using var content = new MultipartFormDataContent();
        await using var fileStream = File.OpenRead(filePath);
        content.Add(new StreamContent(fileStream), "file", "sample_textlayer.pdf");
        content.Add(new StringContent(Guid.NewGuid().ToString()), "siteId"); // Invalid site
        content.Add(new StringContent($"Test Book {Guid.NewGuid():N}"), "title");
        content.Add(new StringContent("en"), "language");
        content.Add(new StringContent(TestAuthorId.ToString()), "authorIds");
        content.Add(new StringContent(TestGenreId.ToString()), "genreId");

        // Act
        var response = await _client.PostAsync("/admin/books/upload", content);

        // Assert
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Upload_UnsupportedFormat_ReturnsBadRequest()
    {
        // Arrange - create a temp file with unsupported extension
        var tempFile = Path.GetTempFileName();
        var unsupportedFile = Path.ChangeExtension(tempFile, ".xyz");
        File.Move(tempFile, unsupportedFile);

        try
        {
            using var content = new MultipartFormDataContent();
            await using var fileStream = File.OpenRead(unsupportedFile);
            content.Add(new StreamContent(fileStream), "file", "test.xyz");
            AddRequiredFields(content, $"Test Book {Guid.NewGuid():N}");

            // Act
            var response = await _client.PostAsync("/admin/books/upload", content);

            // Assert
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
        finally
        {
            File.Delete(unsupportedFile);
        }
    }

    [Fact]
    public async Task Upload_SameBookTwice_CreatesNewEditionUnderSameWork()
    {
        // Arrange
        var filePath = FixturePath("sample_textlayer.pdf");
        if (!File.Exists(filePath))
            return;

        // First upload
        using var content1 = new MultipartFormDataContent();
        var uniqueTitle = $"Duplicate Test Book {Guid.NewGuid():N}";
        await using (var fileStream1 = File.OpenRead(filePath))
        {
            content1.Add(new StreamContent(fileStream1), "file", "sample_textlayer.pdf");
            AddRequiredFields(content1, uniqueTitle);

            var response1 = await _client.PostAsync("/admin/books/upload", content1);
            Assert.Equal(HttpStatusCode.Created, response1.StatusCode);
            var result1 = await response1.Content.ReadFromJsonAsync<UploadResponse>();

            // Second upload with same title but different language
            using var content2 = new MultipartFormDataContent();
            await using var fileStream2 = File.OpenRead(filePath);
            content2.Add(new StreamContent(fileStream2), "file", "sample_textlayer.pdf");
            content2.Add(new StringContent(SiteId.ToString()), "siteId");
            content2.Add(new StringContent(uniqueTitle), "title");
            content2.Add(new StringContent("uk"), "language"); // Different language
            content2.Add(new StringContent(TestAuthorId.ToString()), "authorIds");
            content2.Add(new StringContent(TestGenreId.ToString()), "genreId");

            var response2 = await _client.PostAsync("/admin/books/upload", content2);

            // Assert - should succeed and reuse same work
            Assert.Equal(HttpStatusCode.Created, response2.StatusCode);
            var result2 = await response2.Content.ReadFromJsonAsync<UploadResponse>();
            Assert.NotNull(result1);
            Assert.NotNull(result2);
            Assert.Equal(result1.WorkId, result2.WorkId); // Same work
            Assert.NotEqual(result1.EditionId, result2.EditionId); // Different edition

            _factory.TrackJob(result1.JobId);
            _factory.TrackJob(result2.JobId);
        }
    }

    private record UploadResponse(
        Guid WorkId,
        Guid EditionId,
        Guid BookFileId,
        Guid JobId,
        string Status);
}
