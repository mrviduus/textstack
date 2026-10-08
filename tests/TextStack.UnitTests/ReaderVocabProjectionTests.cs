using Api.Endpoints;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

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

    // The user's NativeLanguage as the subquery the endpoint passes.
    private static IQueryable<string?> Native(string? lang) => new[] { lang }.AsQueryable();

    private static readonly List<VocabularyWord> Words =
    [
        Word("wound", null, "Later she wound the clock."),
        Word("bled", "sangrou", "The wound bled."),
    ];

    [Fact]
    public void ProjectReaderVocab_Always_SentenceOnlyForUntranslated()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), Native("pt")).ToDictionary(d => d.Word);

        Assert.Equal("Later she wound the clock.", dtos["wound"].Sentence);
        Assert.Null(dtos["bled"].Sentence);
    }

    // Review r8: definition mode (word language == native) never backfills, so no sentence ships.
    [Fact]
    public void ProjectReaderVocab_NativeEqualsWordLanguage_NoSentence()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), Native("en")).ToList();

        Assert.All(dtos, d => Assert.Null(d.Sentence));
    }

    // Review r9: the backfill translates from the word's own language, not the open book's.
    [Fact]
    public void ProjectReaderVocab_WordFromOtherLanguage_CarriesItsLanguage()
    {
        var de = Word("Haus", null, "Das Haus ist alt.");
        de.Language = "de";

        var dto = Assert.Single(VocabularyEndpoints.ProjectReaderVocab(new[] { de }.AsQueryable(), Native("pt")));

        Assert.Equal("de", dto.Language);
        Assert.Equal("Das Haus ist alt.", dto.Sentence);
    }

    // Review r9: the native language is a subquery of the one statement, not a second read.
    [Fact]
    public void ProjectReaderVocab_OnPostgres_OneStatementWithUserSubquery()
    {
        using var db = new Infrastructure.Persistence.AppDbContextFactory().CreateDbContext([]);
        var userId = Guid.NewGuid();

        var sql = VocabularyEndpoints.ProjectReaderVocab(
            db.VocabularyWords.Where(w => w.UserId == userId),
            db.Users.Where(u => u.Id == userId).Select(u => u.NativeLanguage)).ToQueryString();

        Assert.Contains("native_language", sql);
        Assert.Contains("vocabulary_words", sql);
    }

    [Fact]
    public void ProjectReaderVocab_NoUserRow_SentenceForUntranslated()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), Array.Empty<string?>().AsQueryable()).ToDictionary(d => d.Word);

        Assert.Equal("Later she wound the clock.", dtos["wound"].Sentence);
    }

    [Fact]
    public void ProjectReaderVocab_NoNativeLanguage_SentenceForUntranslated()
    {
        var dtos = VocabularyEndpoints.ProjectReaderVocab(Words.AsQueryable(), Native(null)).ToDictionary(d => d.Word);

        Assert.Equal("Later she wound the clock.", dtos["wound"].Sentence);
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
