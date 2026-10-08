using Api.Endpoints;
using Domain.Entities;

namespace TextStack.UnitTests;

// Review of #780: the reader word list ships a sentence only for an untranslated word (the
// gloss backfill's context), as a short window around the word — not every saved word's
// whole sentence on every reader open.
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
    ];

    [Fact]
    public void ProjectReaderVocab_Always_SentenceOnlyForUntranslated()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable()).ToDictionary(d => d.Word);

        Assert.Equal("Later she wound the clock.", dtos["wound"].Sentence);
        Assert.Null(dtos["bled"].Sentence);
    }

    [Fact]
    public void SentenceWindow_WordNearEndOfLongSentence_WordInsideCappedWindow()
    {
        var sentence = new string('x', 590) + " Pocketed.";

        var window = VocabularyEndpoints.SentenceWindow(sentence, "pocketed");

        Assert.Equal(VocabularyEndpoints.MaxReaderSentenceLength, window.Length);
        Assert.Contains("Pocketed", window);
    }

    [Fact]
    public void SentenceWindow_WordMissing_TakesStart()
    {
        var sentence = "Start " + new string('x', 600);

        var window = VocabularyEndpoints.SentenceWindow(sentence, "absent");

        Assert.Equal(VocabularyEndpoints.MaxReaderSentenceLength, window.Length);
        Assert.StartsWith("Start ", window);
    }

    [Fact]
    public void SentenceWindow_ShortSentence_Unchanged()
    {
        Assert.Equal("The wound bled.", VocabularyEndpoints.SentenceWindow("The wound bled.", "wound"));
    }
}
