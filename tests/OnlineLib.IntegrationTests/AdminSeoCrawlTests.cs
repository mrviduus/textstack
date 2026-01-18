using System.Net;
using System.Net.Http.Json;

namespace OnlineLib.IntegrationTests;

/// <summary>
/// Integration tests for admin SEO crawl API.
/// Tests sitemap-based URL validation for crawl jobs.
/// </summary>
public class AdminSeoCrawlTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;
    private static readonly Guid SiteId = TestWebApplicationFactory.GeneralSiteId;
    private readonly List<Guid> _createdJobIds = [];

    public AdminSeoCrawlTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task GetPreview_ValidSite_ReturnsUrlCounts()
    {
        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/preview?siteId={SiteId}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<PreviewResult>();
        Assert.NotNull(result);
        Assert.True(result.TotalUrls >= 0);
        Assert.True(result.BookCount >= 0);
        Assert.True(result.AuthorCount >= 0);
        Assert.True(result.GenreCount >= 0);
    }

    [Fact]
    public async Task CreateJob_ValidRequest_ReturnsCreated()
    {
        // Arrange
        var request = new
        {
            siteId = SiteId,
            maxPages = 10
        };

        // Act
        var response = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", request);

        // Assert
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(result);
        Assert.NotEqual(Guid.Empty, result.Id);
        _createdJobIds.Add(result.Id);
    }

    [Fact]
    public async Task CreateJob_InvalidSiteId_ReturnsBadRequest()
    {
        // Arrange
        var request = new
        {
            siteId = Guid.NewGuid() // Non-existent site
        };

        // Act
        var response = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", request);

        // Assert
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task GetJobs_ReturnsJobsList()
    {
        // Arrange - create a job first
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        if (created != null) _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync("/admin/seo-crawl/jobs");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<PaginatedResult<JobListItem>>();
        Assert.NotNull(result);
        Assert.True(result.Total >= 0);
    }

    [Fact]
    public async Task GetJobs_WithSiteFilter_ReturnsFilteredList()
    {
        // Arrange - create a job first
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        if (created != null) _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs?siteId={SiteId}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<PaginatedResult<JobListItem>>();
        Assert.NotNull(result);
        // All returned jobs should belong to the filtered site
        Assert.All(result.Items, item => Assert.Equal(SiteId, item.SiteId));
    }

    [Fact]
    public async Task GetJob_ExistingJob_ReturnsJobDetail()
    {
        // Arrange
        var createRequest = new
        {
            siteId = SiteId,
            maxPages = 50
        };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JobDetail>();
        Assert.NotNull(result);
        Assert.Equal(created.Id, result.Id);
        Assert.Equal(50, result.MaxPages);
        Assert.Equal("Queued", result.Status);
    }

    [Fact]
    public async Task GetJob_NonExistingJob_ReturnsNotFound()
    {
        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs/{Guid.NewGuid()}");

        // Assert
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task StartJob_QueuedJob_ReturnsOk()
    {
        // Arrange
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.PostAsync($"/admin/seo-crawl/jobs/{created.Id}/start", null);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // Verify status changed
        var getResponse = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}");
        var job = await getResponse.Content.ReadFromJsonAsync<JobDetail>();
        Assert.NotNull(job);
        Assert.Equal("Running", job.Status);
    }

    [Fact]
    public async Task CancelJob_RunningJob_ReturnsOk()
    {
        // Arrange - create and start a job
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        await _client.PostAsync($"/admin/seo-crawl/jobs/{created.Id}/start", null);

        // Act
        var response = await _client.PostAsync($"/admin/seo-crawl/jobs/{created.Id}/cancel", null);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // Verify status changed
        var getResponse = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}");
        var job = await getResponse.Content.ReadFromJsonAsync<JobDetail>();
        Assert.NotNull(job);
        Assert.Equal("Cancelled", job.Status);
    }

    [Fact]
    public async Task GetJobStats_ExistingJob_ReturnsStats()
    {
        // Arrange
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}/stats");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JobStats>();
        Assert.NotNull(result);
        Assert.Equal(0, result.Total); // No crawl yet
    }

    [Fact]
    public async Task GetResults_ExistingJob_ReturnsResults()
    {
        // Arrange
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}/results");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<PaginatedResult<CrawlResult>>();
        Assert.NotNull(result);
        Assert.Equal(0, result.Total); // No crawl yet
    }

    [Fact]
    public async Task ExportCsv_ExistingJob_ReturnsCsv()
    {
        // Arrange
        var createRequest = new { siteId = SiteId };
        var createResponse = await _client.PostAsJsonAsync("/admin/seo-crawl/jobs", createRequest);
        var created = await createResponse.Content.ReadFromJsonAsync<CreateJobResponse>();
        Assert.NotNull(created);
        _createdJobIds.Add(created.Id);

        // Act
        var response = await _client.GetAsync($"/admin/seo-crawl/jobs/{created.Id}/export.csv");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/csv", response.Content.Headers.ContentType?.MediaType);

        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("URL,Type,Status Code", content); // CSV header
    }

    private record CreateJobResponse(Guid Id);

    private record PreviewResult(
        int TotalUrls,
        int BookCount,
        int AuthorCount,
        int GenreCount);

    private record PaginatedResult<T>(int Total, List<T> Items);

    private record JobListItem(
        Guid Id,
        Guid SiteId,
        string SiteCode,
        string Status,
        int TotalUrls,
        int MaxPages,
        int PagesCrawled,
        int ErrorsCount);

    private record JobDetail(
        Guid Id,
        Guid SiteId,
        string SiteCode,
        string Status,
        int TotalUrls,
        int MaxPages,
        int Concurrency,
        int CrawlDelayMs);

    private record JobStats(
        int Total,
        int Status2xx,
        int Status3xx,
        int Status4xx,
        int Status5xx,
        int MissingTitle,
        int MissingDescription,
        int MissingH1,
        int NoIndex);

    private record CrawlResult(
        Guid Id,
        string Url,
        string UrlType,
        int? StatusCode,
        string? Title);
}
