using Application.Ai;

namespace TextStack.UnitTests;

/// <summary>
/// AI-039 — the shared deterministic detector behind the Explain pre-router. A self-contained
/// passage must detect nothing (the floor that stops Explain reaching for tools it does not need);
/// positive wordings must light up exactly their flag, and a combined sentence ORs them.
/// </summary>
public class BookToolTriggersTests
{
    // Passages that stand on their own: nothing in them refers out to another chapter, to something
    // said earlier, or to the reader's own marks. These used to come from the Study Buddy golden set;
    // they are inline now that it is gone, because the floor they pin belongs to Explain either way.
    [Theory]
    [InlineData("A distributed system is one in which the failure of a computer you did not know existed can render your own computer unusable.")]
    [InlineData("Reliability means continuing to work correctly even when things go wrong.")]
    [InlineData("An index is an additional structure derived from the primary data.")]
    [InlineData("Encoding is the translation from an in-memory representation to a byte sequence.")]
    public void Detect_SelfContainedPassage_IsNone(string passage) =>
        Assert.Equal(BookToolSignal.None, BookToolTriggers.Detect(passage));

    [Theory]
    [InlineData("As we saw in Chapter 5, this builds on earlier ideas.")]
    [InlineData("Chapter 9 examines linearizability in depth.")]
    public void Detect_ChapterNumberWording_FlagsChapterNumber(string text) =>
        Assert.True(BookToolTriggers.Detect(text).HasFlag(BookToolSignal.ChapterNumber));

    [Theory]
    [InlineData("As we discussed earlier, quorums overlap.")]
    [InlineData("This was mentioned before in the context of replication.")]
    public void Detect_EarlierReferenceWording_FlagsEarlierReference(string text) =>
        Assert.True(BookToolTriggers.Detect(text).HasFlag(BookToolSignal.EarlierReference));

    [Theory]
    [InlineData("Compare this with my highlights from the last chapter.")]
    [InlineData("I marked a similar passage about this earlier.")]
    [InlineData("Connect it to my notes on storage engines.")]
    public void Detect_HighlightsWording_FlagsUserHighlights(string text) =>
        Assert.True(BookToolTriggers.Detect(text).HasFlag(BookToolSignal.UserHighlights));

    [Fact]
    public void Detect_CombinedWording_OrsEveryMatchedFlag()
    {
        const string text =
            "In Chapter 5 we discussed this earlier; compare it to my highlights on the topic.";
        var signal = BookToolTriggers.Detect(text);
        Assert.True(signal.HasFlag(BookToolSignal.ChapterNumber));
        Assert.True(signal.HasFlag(BookToolSignal.EarlierReference));
        Assert.True(signal.HasFlag(BookToolSignal.UserHighlights));
    }

    [Theory]
    [InlineData("Serializable snapshot isolation is an optimistic concurrency control technique.")]
    [InlineData("This was a long chapter about many things.")] // "chapter" without a number
    [InlineData("Earlier adopters of NoSQL hit this problem.")] // "earlier" without discussed/mentioned
    public void Detect_PlainTechnicalSentence_IsNone(string text) =>
        Assert.Equal(BookToolSignal.None, BookToolTriggers.Detect(text));

    // AI-039 QA P3 — "earlier"/"previously" co-occurring with a high-frequency verb in a SELF-CONTAINED
    // sentence (no cross-reference intent) must NOT light up EarlierReference. The discuss-verb and the
    // temporal token are too far apart, or separated by a noun phrase, to be a real "discussed earlier".
    [Theory]
    [InlineData("Earlier adopters of NoSQL covered their bets.")] // temporal → verb across a noun phrase
    [InlineData("The earlier benchmark mentioned a slow node.")] // temporal → noun → verb
    [InlineData("I covered the topic earlier today.")] // bare "covered" not adjacent to the temporal token
    public void Detect_SelfContainedSentenceWithEarlierAndVerb_IsNone(string text) =>
        Assert.Equal(BookToolSignal.None, BookToolTriggers.Detect(text));
}
