using System.Text.Json;
using Api.Endpoints;
using Application.Annotations;
using Contracts.Sync;

namespace TextStack.UnitTests;

// #1580: the highlights page shows a book's cover from the URL the library builds (syncApi.coverUrl(id, updatedAt)),
// so the same cover is fetched and cached once and shows offline where the library cached it.
public class HighlightCoverTests
{
    // Sub-microsecond ticks: the key must match the library's whatever the precision.
    private static readonly DateTimeOffset Version = new DateTimeOffset(2026, 11, 24, 9, 30, 15, TimeSpan.Zero).AddTicks(1234567);

    private static AnnotationListItem Highlight(bool removed, DateTimeOffset? coverVersion) => new(
        Guid.NewGuid(), "quote", "{}", "yellow", null, DateTimeOffset.UnixEpoch,
        Guid.NewGuid(), "A Book", removed, null, "Chapter", "ch1", coverVersion);

    [Fact]
    public void ToHighlightDto_BookWithACover_CarriesItsVersionAndNoStoragePath()
    {
        var dto = CompatEndpoints.ToHighlightDto(Highlight(removed: false, Version));

        Assert.Equal(Version, dto.UserBookCoverVersion);
        Assert.Null(dto.UserBookCoverPath); // an old Android build passes it to getStorageUrl: a broken box
    }

    [Fact]
    public void ToHighlightDto_BookWithoutACover_HasNoVersion()
    {
        Assert.Null(CompatEndpoints.ToHighlightDto(Highlight(removed: false, null)).UserBookCoverVersion);
    }

    [Fact]
    public void ToHighlightDto_RemovedBook_HasNoVersion()
    {
        var dto = CompatEndpoints.ToHighlightDto(Highlight(removed: true, Version));

        Assert.Null(dto.UserBookCoverVersion);
        Assert.Equal("A Book", dto.DeletedBookTitle);
    }

    [Fact]
    public void ToHighlightDto_CoverVersion_SerialisesExactlyLikeTheLibrarysUpdatedAt()
    {
        var book = new BookDto(Guid.NewGuid(), "A Book", null, null, null, null, null, [], false, true, 1,
            DateTimeOffset.UnixEpoch, Version, null, null);

        var highlight = JsonSerializer.SerializeToElement(CompatEndpoints.ToHighlightDto(Highlight(false, Version)), JsonSerializerOptions.Web);
        var library = JsonSerializer.SerializeToElement(book, JsonSerializerOptions.Web);

        Assert.Equal(library.GetProperty("updatedAt").GetString(), highlight.GetProperty("userBookCoverVersion").GetString());
    }
}
