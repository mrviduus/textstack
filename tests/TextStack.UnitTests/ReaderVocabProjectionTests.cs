using Api.Endpoints;
using Domain.Entities;

namespace TextStack.UnitTests;

// Review of #780: the reader word list ships a sentence only when the gloss backfill asks
// (includeSentences=true), only for an untranslated word, and capped — not every saved
// word's sentence on every reader open.
public class ReaderVocabProjectionTests
{
    private static VocabularyWord Word(string word, string? translation, string? sentence) => new()
    {
        Id = Guid.NewGuid(),
        Word = word,
        Language = "en",
        Translation = translation,
        Sentence = sentence,
    };

    private static readonly List<VocabularyWord> Words =
    [
        Word("wound", null, "Later she wound the clock."),
        Word("bled", "sangrou", "The wound bled."),
        Word("long", null, new string('x', 1000)),
    ];

    [Fact]
    public void ProjectReaderVocab_NotRequested_NoSentences()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), includeSentences: false).ToList();

        Assert.All(dtos, d => Assert.Null(d.Sentence));
    }

    [Fact]
    public void ProjectReaderVocab_Requested_SentenceOnlyForUntranslated()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), includeSentences: true)
            .ToDictionary(d => d.Word);

        Assert.Equal("Later she wound the clock.", dtos["wound"].Sentence);
        Assert.Null(dtos["bled"].Sentence);
    }

    [Fact]
    public void ProjectReaderVocab_LongSentence_CappedAtMax()
    {
        var dto = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), includeSentences: true)
            .Single(d => d.Word == "long");

        Assert.Equal(VocabularyEndpoints.MaxReaderSentenceLength, dto.Sentence!.Length);
    }
}
