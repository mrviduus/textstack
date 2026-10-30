using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// The Api no longer migrates (ADR-021): the `migrator` compose service is the only thing that
/// brings the schema up. This proves it did, on the stack the suite runs against, and that the
/// readiness probe is the place a schema behind the build shows up.
/// </summary>
public class SchemaReadinessTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public SchemaReadinessTests(LiveApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task HealthReady_AfterMigrator_ReportsSchemaOk()
    {
        var ct = TestContext.Current.CancellationToken;
        // Not asserting the overall status code: storage/ollama are separate components.
        var resp = await _fixture.Client.GetAsync("/health/ready", ct);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);

        var components = body.GetProperty("components");
        Assert.SkipWhen(!components.TryGetProperty("schema", out var schema),
            "API predates the schema readiness component");
        Assert.Equal("ok", schema.GetProperty("status").GetString());
    }

    // A fresh container's data directory was made by the glibc it is running, so anything but "ok"
    // here means the component itself is broken — the query, not the cluster (#1056).
    [Fact]
    public async Task HealthReady_FreshCluster_ReportsCollationOk()
    {
        var ct = TestContext.Current.CancellationToken;
        var resp = await _fixture.Client.GetAsync("/health/ready", ct);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);

        var components = body.GetProperty("components");
        Assert.SkipWhen(!components.TryGetProperty("collation", out var collation),
            "API predates the collation readiness component");
        Assert.Equal("ok", collation.GetProperty("status").GetString());
    }
}
