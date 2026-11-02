using System.Security.Cryptography;
using System.Text;
using Application.Vocabulary;
using Domain.Vocabulary;

namespace TextStack.UnitTests.V2;

/// <summary>
/// Golden vectors for the Example and Review rows of v2-sync-protocol.md "Canonical JSON": the exact
/// canonical bytes and their sha256. The M3 ETL must reproduce these, so a change here is a protocol change.
/// </summary>
public class VocabularyPayloadsTests
{
    private static readonly Guid WordId = Guid.Parse("5E1A2B3C-4D5E-4F60-8172-839405A6B7C8");
    private static readonly Guid BookId = Guid.Parse("0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    private static readonly Guid FileId = Guid.Parse("7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f");

    // The card as stored: the hash takes its key and language, whatever the request spelled.
    private static readonly VocabularyWord Quiver = new() { Id = WordId, Language = "en", Word = "Quiver", WordKey = "quiver" };

    private static string Sha(string canonical) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));

    // The PDD's own example: the offset is normalised to UTC, milliseconds kept, the null omitted, the UUID lowered.
    [Fact]
    public void ReviewSha256_ThePddsExample_HashesItsCanonicalBytes()
    {
        const string canonical =
            """{"clientRecordedAt":"2026-10-30T18:15:03.500Z","isCorrect":true,"reviewMode":"multiple_choice","wordId":"5e1a2b3c-4d5e-4f60-8172-839405a6b7c8"}""";

        var sha = VocabularyPayloads.ReviewSha256(new VocabularyReview { WordId = WordId, ReviewMode = "multiple_choice", IsCorrect = true, ClientRecordedAt = DateTimeOffset.Parse("2026-10-30T20:15:03.5+02:00") });

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("eb9e573fcda5712a5ff2bfb3c4099cd783e44de88b5ce945c4f1947ccdd7de61", sha);
    }

    [Fact]
    public void ExampleSha256_EveryField_HashesItsCanonicalBytes()
    {
        const string canonical =
            """{"bookId":"0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","bookTitle":"Dracula","chapterKey":"ch02.xhtml","contextualTranslation":"колчан","fileId":"7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f","language":"en","sentence":"Her voice began to \"quiver\".","wordKey":"quiver"}""";

        var sha = VocabularyPayloads.ExampleSha256(Quiver, new VocabularyExample { Sentence = "Her voice began to \"quiver\".", ContextualTranslation = "колчан", BookId = BookId, FileId = FileId, ChapterKey = "ch02.xhtml", BookTitle = "Dracula" });

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("e4ccb4e342b6e563e037b8199886776cb6f82515029d0dbf26feec301d1fa3cc", sha);
    }

    [Fact]
    public void ExampleSha256_NullFields_AreOmitted()
    {
        const string canonical = """{"language":"en","sentence":"It quivered.","wordKey":"quiver"}""";

        var sha = VocabularyPayloads.ExampleSha256(Quiver, new VocabularyExample { Sentence = "It quivered." });

        Assert.Equal(Sha(canonical), sha);
        Assert.Equal("70019b7803182017a3891d768ddb29c163e4ed1c7c67844175531472058434f5", sha);
    }
}
