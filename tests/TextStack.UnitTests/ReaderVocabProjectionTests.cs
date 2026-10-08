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

        Assert.True(window.Length <= VocabularyEndpoints.MaxReaderSentenceLength);
        Assert.Contains("Pocketed", window);
    }

    // Review r7 of #780: 'art' is found as a word, not inside 'Start'.
    [Fact]
    public void SentenceWindow_WordAlsoInsideEarlierWord_CentredOnWholeWord()
    {
        var sentence = "Start " + new string('x', 400) + " the Art of war " + new string('y', 400);

        var window = VocabularyEndpoints.SentenceWindow(sentence, "art");

        Assert.Contains("the Art of war", window);
        Assert.DoesNotContain("Start", window);
    }

    [Fact]
    public void SentenceWindow_WordOnlyInsideAnother_FallsBackToSubstring()
    {
        var sentence = new string('x', 400) + " Restarted " + new string('y', 400);

        Assert.Contains("Restarted", VocabularyEndpoints.SentenceWindow(sentence, "start"));
    }

    [Fact]
    public void SentenceWindow_WordMissing_TakesStart()
    {
        var sentence = "Start " + new string('x', 600);

        var window = VocabularyEndpoints.SentenceWindow(sentence, "absent");

        Assert.True(window.Length <= VocabularyEndpoints.MaxReaderSentenceLength);
        Assert.StartsWith("Start", window);
    }

    [Fact]
    public void SentenceWindow_ShortSentence_Unchanged()
    {
        Assert.Equal("The wound bled.", VocabularyEndpoints.SentenceWindow("The wound bled.", "wound"));
    }

    // Review r6 of #780: the window never cuts a word in half, nor an emoji's surrogate pair.
    [Fact]
    public void SentenceWindow_LongWordsAtBothEdges_CutsOnlyAtWordBoundaries()
    {
        const string Long = "Incomprehensibilities";
        var side = string.Join(" ", Enumerable.Repeat(Long, 30));
        var sentence = side + " He pocketed the coins " + side;

        var window = VocabularyEndpoints.SentenceWindow(sentence, "pocketed");

        Assert.True(window.Length <= VocabularyEndpoints.MaxReaderSentenceLength);
        Assert.Contains("pocketed", window);
        Assert.All(window.Split(' '), t => Assert.Contains(t, new[] { Long, "He", "pocketed", "the", "coins" }));
    }

    [Theory]
    [InlineData("a")] // pairs at odd offsets
    [InlineData("")]  // pairs at even offsets
    public void SentenceWindow_EmojiAtCutNoSpaces_NoLoneSurrogate(string pad)
    {
        var emojis = string.Concat(Enumerable.Repeat("\U0001F600", 300));
        var sentence = pad + emojis + "pocketed" + emojis;

        var window = VocabularyEndpoints.SentenceWindow(sentence, "pocketed");

        Assert.True(window.Length <= VocabularyEndpoints.MaxReaderSentenceLength);
        Assert.Contains("pocketed", window);
        // Strict UTF-8 throws on a lone surrogate.
        new System.Text.UTF8Encoding(false, true).GetBytes(window);
    }
}
