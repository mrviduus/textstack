using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace OnlineLib.IntegrationTests;

public class SsgRebuildEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;
    private readonly TestWebApplicationFactory _factory;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public SsgRebuildEndpointTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateAdminClient();
    }

    [Fact]
    public async Task GetPreview_ReturnsRouteCounts()
    {
        // Act
        var response = await _client.GetAsync($"/admin/ssg/preview?siteId={TestWebApplicationFactory.GeneralSiteId}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var preview = JsonSerializer.Deserialize<SsgRebuildPreviewResponse>(content, JsonOptions);

        Assert.NotNull(preview);
        Assert.True(preview.TotalRoutes > 0);
        Assert.True(preview.StaticCount > 0); // Should have static pages like /, /books, etc.
    }

    [Fact]
    public async Task GetPreview_WithMode_FiltersCorrectly()
    {
        // Act - Full mode
        var fullResponse = await _client.GetAsync($"/admin/ssg/preview?siteId={TestWebApplicationFactory.GeneralSiteId}&mode=Full");
        var fullContent = await fullResponse.Content.ReadAsStringAsync();
        var fullPreview = JsonSerializer.Deserialize<SsgRebuildPreviewResponse>(fullContent, JsonOptions);

        // Assert
        Assert.NotNull(fullPreview);
        Assert.True(fullPreview.StaticCount > 0, "Full mode should include static pages");
    }

    [Fact]
    public async Task CreateJob_ReturnsJobId()
    {
        // Arrange
        var request = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full",
            concurrency = 2
        };

        // Act
        var response = await _client.PostAsJsonAsync("/admin/ssg/jobs", request);

        // Assert
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var result = JsonSerializer.Deserialize<CreateJobResponse>(content, JsonOptions);

        Assert.NotNull(result);
        Assert.NotEqual(Guid.Empty, result.Id);

        // Cleanup - track for deletion
        _factory.TrackJob(result.Id);
    }

    [Fact]
    public async Task CreateJob_InvalidSite_ReturnsBadRequest()
    {
        // Arrange
        var request = new
        {
            siteId = Guid.NewGuid(), // Non-existent site
            mode = "Full"
        };

        // Act
        var response = await _client.PostAsJsonAsync("/admin/ssg/jobs", request);

        // Assert
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task GetJobs_ReturnsJobList()
    {
        // Arrange - Create a job first
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full",
            concurrency = 2
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        // Act
        var response = await _client.GetAsync($"/admin/ssg/jobs?siteId={TestWebApplicationFactory.GeneralSiteId}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var result = JsonSerializer.Deserialize<JobListResponse>(content, JsonOptions);

        Assert.NotNull(result);
        Assert.True(result.Total > 0);
        Assert.NotEmpty(result.Items);
    }

    [Fact]
    public async Task GetJob_ExistingJob_ReturnsJobDetail()
    {
        // Arrange - Create a job first
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full",
            concurrency = 2
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        // Act
        var response = await _client.GetAsync($"/admin/ssg/jobs/{createResult.Id}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var job = JsonSerializer.Deserialize<SsgRebuildJobDetail>(content, JsonOptions);

        Assert.NotNull(job);
        Assert.Equal(createResult.Id, job.Id);
        Assert.Equal("Queued", job.Status);
        Assert.Equal("Full", job.Mode);
        Assert.Equal(2, job.Concurrency);
    }

    [Fact]
    public async Task GetJob_NonExistent_ReturnsNotFound()
    {
        // Act
        var response = await _client.GetAsync($"/admin/ssg/jobs/{Guid.NewGuid()}");

        // Assert
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task StartJob_QueuedJob_StartsSuccessfully()
    {
        // Arrange - Create a job
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full",
            concurrency = 2
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        // Act
        var response = await _client.PostAsync($"/admin/ssg/jobs/{createResult.Id}/start", null);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // Verify job is now Running
        var jobResponse = await _client.GetAsync($"/admin/ssg/jobs/{createResult.Id}");
        var job = JsonSerializer.Deserialize<SsgRebuildJobDetail>(
            await jobResponse.Content.ReadAsStringAsync(), JsonOptions);

        Assert.Equal("Running", job!.Status);
    }

    [Fact]
    public async Task CancelJob_RunningJob_CancelsSuccessfully()
    {
        // Arrange - Create and start a job
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full",
            concurrency = 2
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        await _client.PostAsync($"/admin/ssg/jobs/{createResult.Id}/start", null);

        // Act
        var response = await _client.PostAsync($"/admin/ssg/jobs/{createResult.Id}/cancel", null);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // Verify job is now Cancelled
        var jobResponse = await _client.GetAsync($"/admin/ssg/jobs/{createResult.Id}");
        var job = JsonSerializer.Deserialize<SsgRebuildJobDetail>(
            await jobResponse.Content.ReadAsStringAsync(), JsonOptions);

        Assert.Equal("Cancelled", job!.Status);
    }

    [Fact]
    public async Task GetJobStats_ReturnsStats()
    {
        // Arrange - Create a job
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full"
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        // Act
        var response = await _client.GetAsync($"/admin/ssg/jobs/{createResult.Id}/stats");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var stats = JsonSerializer.Deserialize<SsgRebuildJobStats>(content, JsonOptions);

        Assert.NotNull(stats);
        // Initially should have 0 results since job hasn't processed anything
        Assert.Equal(0, stats.Total);
    }

    [Fact]
    public async Task GetResults_ReturnsEmptyForNewJob()
    {
        // Arrange - Create a job
        var createRequest = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Full"
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/ssg/jobs", createRequest);
        var createResult = JsonSerializer.Deserialize<CreateJobResponse>(
            await createResponse.Content.ReadAsStringAsync(), JsonOptions);

        _factory.TrackJob(createResult!.Id);

        // Act
        var response = await _client.GetAsync($"/admin/ssg/jobs/{createResult.Id}/results");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var results = JsonSerializer.Deserialize<ResultsResponse>(content, JsonOptions);

        Assert.NotNull(results);
        Assert.Equal(0, results.Total);
        Assert.Empty(results.Items);
    }

    [Fact]
    public async Task CreateJob_SpecificMode_WithBookSlugs()
    {
        // Arrange
        var request = new
        {
            siteId = TestWebApplicationFactory.GeneralSiteId,
            mode = "Specific",
            concurrency = 2,
            bookSlugs = new[] { TestWebApplicationFactory.PublishedBookSlug }
        };

        // Act
        var response = await _client.PostAsJsonAsync("/admin/ssg/jobs", request);

        // Assert
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var content = await response.Content.ReadAsStringAsync();
        var result = JsonSerializer.Deserialize<CreateJobResponse>(content, JsonOptions);

        Assert.NotNull(result);
        _factory.TrackJob(result.Id);

        // Verify the job has correct settings
        var jobResponse = await _client.GetAsync($"/admin/ssg/jobs/{result.Id}");
        var job = JsonSerializer.Deserialize<SsgRebuildJobDetail>(
            await jobResponse.Content.ReadAsStringAsync(), JsonOptions);

        Assert.Equal("Specific", job!.Mode);
        Assert.NotNull(job.BookSlugs);
        Assert.Contains(TestWebApplicationFactory.PublishedBookSlug, job.BookSlugs);
    }

    // Response DTOs for deserialization
    private record SsgRebuildPreviewResponse(
        int TotalRoutes,
        int BookCount,
        int AuthorCount,
        int GenreCount,
        int StaticCount
    );

    private record CreateJobResponse(Guid Id);

    private record JobListResponse(int Total, List<SsgRebuildJobListItem> Items);

    private record SsgRebuildJobListItem(
        Guid Id,
        Guid SiteId,
        string SiteCode,
        string Mode,
        string Status,
        int TotalRoutes,
        int RenderedCount,
        int FailedCount,
        int Concurrency,
        string CreatedAt,
        string? StartedAt,
        string? FinishedAt
    );

    private record SsgRebuildJobDetail(
        Guid Id,
        Guid SiteId,
        string SiteCode,
        string Mode,
        string Status,
        int TotalRoutes,
        int RenderedCount,
        int FailedCount,
        int Concurrency,
        int TimeoutMs,
        string? Error,
        string[]? BookSlugs,
        string[]? AuthorSlugs,
        string[]? GenreSlugs,
        string CreatedAt,
        string? StartedAt,
        string? FinishedAt
    );

    private record SsgRebuildJobStats(
        int Total,
        int Successful,
        int Failed,
        int BookRoutes,
        int AuthorRoutes,
        int GenreRoutes,
        int StaticRoutes,
        double AvgRenderTimeMs
    );

    private record ResultsResponse(int Total, List<SsgRebuildResult> Items);

    private record SsgRebuildResult(
        Guid Id,
        string Route,
        string RouteType,
        bool Success,
        int? RenderTimeMs,
        string? Error,
        string RenderedAt
    );
}
