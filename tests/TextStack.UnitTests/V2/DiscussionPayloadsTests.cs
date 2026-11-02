using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Discussion;
using Contracts.V2;
using Domain.Discussion;

namespace TextStack.UnitTests.V2;

/// <summary>
/// Golden vectors for the Share and Checkpoint rows of v2-sync-protocol.md "Canonical JSON": the exact
/// canonical bytes and their sha256. The M3 ETL must reproduce these, so a change here is a protocol change.
/// </summary>
public class DiscussionPayloadsTests
{
    private static readonly Guid BookId = Guid.Parse("0B6A1C2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D");
    private static readonly Guid FileId = Guid.Parse("7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f");
    private static readonly Guid ShareId = Guid.Parse("1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6");

    private static JsonElement Notes(string json) => JsonDocument.Parse(json).RootElement;

    private static string Sha(string canonical) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));

    // The notes as sent: members out of order, whitespace, a 1.0 — the hash sees them sorted, bare and as 1.
    [Fact]
    public void ShareSha256_EveryField_HashesItsCanonicalBytes()
    {
        const string canonical =
            """{"bookId":"0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","chapterKey":"ch02.xhtml","chapterText":"It was the night.\nДракула","chapterTitle":"Chapter II","fileId":"7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f","language":"en","notes":[{"rect":{"x":1,"y":0.5},"text":"night"}]}""";

        var sha = DiscussionPayloads.ShareSha256(BookId, new ShareChapterRequest(
            Guid.NewGuid(), FileId, "ch02.xhtml", "Chapter II", "It was the night.\nДракула",
            Notes("""[{ "text": "night", "rect": { "y": 0.5, "x": 1.0 } }]"""), "en"));

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("49f9aa7177436f00193a7009f4782177342e825a35a057b1d7123ba6b7482059", sha);
    }

    [Fact]
    public void ShareSha256_NullFields_AreOmittedAndEmptyNotesKept()
    {
        const string canonical = """{"bookId":"0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","chapterKey":"ch02.xhtml","chapterText":"Text.","notes":[]}""";

        var sha = DiscussionPayloads.ShareSha256(BookId, new ShareChapterRequest(Guid.NewGuid(), null, "ch02.xhtml", null, "Text.", Notes("[]"), null));

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("4bab52088762b921313cbcefcdda9ada3ee7962c4b19ef1d9f0b7126757541c5", sha);
    }

    [Fact]
    public void CheckpointSha256_EveryField_HashesItsCanonicalBytesWithSectionsInOrder()
    {
        const string canonical =
            """{"assistantSuggestions":["Compare with chapter I."],"bookId":"0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","chapterKey":"ch02.xhtml","conclusions":[],"fileId":"7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f","language":"uk","openQuestions":["Who wrote the letter?"],"readerThoughts":["Second thought","First \"thought\""],"sharedChapterId":"1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6","topic":"Тон листа"}""";

        var sha = DiscussionPayloads.CheckpointSha256(BookId, new CheckpointRequest(
            Guid.NewGuid(), "Тон листа", ["Second thought", "First \"thought\""], ["Compare with chapter I."], [], ["Who wrote the letter?"],
            "uk", "ch02.xhtml", FileId, ShareId));

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("74995d089532c0a5d96b929cc22315997ef94f2713167673dedaa1425af3f613", sha);
    }

    [Fact]
    public void CheckpointSha256_NoProvenance_IsOmitted()
    {
        const string canonical =
            """{"assistantSuggestions":[],"bookId":"0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","conclusions":["It is about trust."],"language":"en","openQuestions":[],"readerThoughts":[],"topic":"The book"}""";

        var sha = DiscussionPayloads.CheckpointSha256(BookId, new CheckpointRequest(
            Guid.NewGuid(), "The book", [], [], ["It is about trust."], [], "en", null, null, null));

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("2e150f50a68d6cbec1ef3857219c354544dc868ad9c919454c194113d31931fa", sha);
    }

    // The golden rows again, as the database stores them (the jsonb text of notes and sections): the merge
    // and the ETL hash a stored row, and must get the request's hash.
    [Fact]
    public void ShareSha256_StoredRow_HashesAsItsRequest()
    {
        var row = new SharedChapter
        {
            BookId = BookId,
            FileId = FileId,
            ChapterKey = "ch02.xhtml",
            ChapterTitle = "Chapter II",
            ChapterText = "It was the night.\nДракула",
            NotesSnapshot = """[{"rect": {"x": 1.0, "y": 0.5}, "text": "night"}]""",
            Language = "en",
        };

        Assert.Equal("49f9aa7177436f00193a7009f4782177342e825a35a057b1d7123ba6b7482059", DiscussionPayloads.ShareSha256(row));
    }

    [Fact]
    public void Checkpoint_FromARequest_StoresTheSectionsAndARowHashEqualToTheRequests()
    {
        var request = new CheckpointRequest(
            Guid.NewGuid(), "Тон листа", ["Second thought", "First \"thought\""], ["Compare with chapter I."], [], ["Who wrote the letter?"],
            "uk", "ch02.xhtml", FileId, ShareId);

        var row = DiscussionPayloads.Checkpoint(Guid.NewGuid(), Guid.NewGuid(), BookId, request);

        Assert.Equal(("74995d089532c0a5d96b929cc22315997ef94f2713167673dedaa1425af3f613", request.OperationId!.Value),
            (row.PayloadSha256, row.OperationId));
        Assert.Equal(row.PayloadSha256, DiscussionPayloads.CheckpointSha256(row));
    }
}
