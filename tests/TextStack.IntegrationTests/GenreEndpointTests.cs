using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// <c>GET /genres/{slug}</c> — the shape a genre page is actually served.
///
/// <para>This exists because of a defect that survived a year of review, a compiler and two clients:
/// the projection sent an edition with no <c>authors</c> at all, while the shared TypeScript type
/// declared these as full editions. The mobile genre screen therefore called
/// <c>ed.authors.map(...)</c> and threw on EVERY genre that has books; the web wrote
/// <c>ed.authors || []</c> and rendered its "Popular authors" section empty forever. Nothing failed
/// loudly, and nothing tested the wire.</para>
///
/// <para>A unit test could not have caught it — the bug was in an EF projection, and the only
/// question that matters is what the endpoint puts on the wire.</para>
/// </summary>
public class GenreEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public GenreEndpointTests(LiveApiFixture fixture) => _fixture = fixture;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>The first genre that actually has published books, or null when none is seeded.</summary>
    private async Task<JsonElement?> FirstGenreWithBooksAsync()
    {
        var listResp = await _fixture.Client.SendAsync(_fixture.CreateRequest(HttpMethod.Get, "/genres"), Ct);
        if (!listResp.IsSuccessStatusCode) return null;

        var list = await listResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        var items = list.ValueKind == JsonValueKind.Array ? list
            : list.TryGetProperty("items", out var inner) ? inner : default;
        if (items.ValueKind != JsonValueKind.Array) return null;

        foreach (var g in items.EnumerateArray())
        {
            if (g.TryGetProperty("bookCount", out var c) && c.GetInt32() == 0) continue;
            var slug = g.GetProperty("slug").GetString();

            var detail = await _fixture.Client.SendAsync(
                _fixture.CreateRequest(HttpMethod.Get, $"/genres/{slug}"), Ct);
            if (!detail.IsSuccessStatusCode) continue;

            var body = await detail.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
            if (body.TryGetProperty("editions", out var eds) && eds.GetArrayLength() > 0)
                return body;
        }

        return null;
    }

    [Fact]
    public async Task GetGenre_EveryEdition_CarriesTheAuthorsBothClientsRender()
    {
        var genre = await FirstGenreWithBooksAsync();
        Assert.SkipWhen(genre is null, "no seeded genre with published editions");

        var editions = genre!.Value.GetProperty("editions").EnumerateArray().ToArray();

        foreach (var ed in editions)
        {
            // Present, and an ARRAY. Absent is what threw on the phone; null would throw the same way.
            Assert.True(ed.TryGetProperty("authors", out var authors),
                $"edition '{ed.GetProperty("slug")}' has no authors field — the mobile genre screen maps over it");
            Assert.Equal(JsonValueKind.Array, authors.ValueKind);
        }

        // At least one book in the catalogue must actually name an author, or the assertion above
        // passes on a projection that sends empty arrays for everything — which is the same blank
        // screen with a different cause.
        Assert.Contains(editions, e => e.GetProperty("authors").GetArrayLength() > 0);
    }

    [Fact]
    public async Task GetGenre_AnAuthor_HasTheFieldsACardNeeds()
    {
        var genre = await FirstGenreWithBooksAsync();
        Assert.SkipWhen(genre is null, "no seeded genre with published editions");

        var author = genre!.Value.GetProperty("editions").EnumerateArray()
            .SelectMany(e => e.GetProperty("authors").EnumerateArray())
            .FirstOrDefault();
        Assert.SkipWhen(author.ValueKind != JsonValueKind.Object, "no seeded edition has an author");

        // `name` is what both clients print; `slug` is what a card would link to.
        Assert.False(string.IsNullOrWhiteSpace(author.GetProperty("name").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(author.GetProperty("slug").GetString()));
    }
}
