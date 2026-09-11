using System.Text.Json;
using TextStack.Vocabulary.Contracts;

namespace TextStack.Vocabulary;

public sealed class ReviewCardBuilder : IReviewCardBuilder
{
    private readonly ISrsEngine _srsEngine;

    public ReviewCardBuilder(ISrsEngine srsEngine)
    {
        _srsEngine = srsEngine;
    }

    public List<ReviewCard> BuildCards(
        IReadOnlyList<WordForReview> dueWords,
        IReadOnlyList<DistractorPoolEntry> distractorPool)
    {
        var poolByLang = distractorPool
            .GroupBy(d => d.Language)
            .ToDictionary(g => g.Key, g => g.ToList());

        var cards = new List<ReviewCard>(dueWords.Count);

        foreach (var w in dueWords)
        {
            var reviewMode = _srsEngine.GetReviewMode(w.Stage, w.Sentence != null);
            List<string>? options = null;
            int? correctIndex = null;
            string? blankSentence = null;

            // Both modes end up as a four-option card; the difference is only the prompt. Context
            // shows the sentence with the word removed, so the options ARE the cloze; plain MC shows
            // the definition or translation. They used to build their options from two copies of the
            // same forty lines — see McOptions for why that is now one.
            if (reviewMode is "multiple_choice" or "context")
            {
                if (w.Sentence != null)
                    blankSentence = SentenceHelper.ReplaceWordInSentence(w.Sentence, w.Word);

                var pool = poolByLang.GetValueOrDefault(w.Language, []);
                (options, var index) = McOptions.Build(w.Word, w.Language, w.DistractorsJson, pool);
                correctIndex = index;

                // Context cloze is rendered by the MC card, so it travels as one. The mode a client
                // reads must describe the card it is about to draw, not the SRS stage behind it.
                reviewMode = "multiple_choice";
            }

            var isNew = w.Stage == 0 && w.TotalReviews == 0;

            cards.Add(new ReviewCard(
                w.Id, w.Word, w.Translation, w.Definition,
                reviewMode, blankSentence, w.Sentence, w.BookTitle,
                w.Hint, w.Explanation, isNew, options, correctIndex));
        }

        return cards;
    }

}
