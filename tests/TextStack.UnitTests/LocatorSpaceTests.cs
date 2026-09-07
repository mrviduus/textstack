using Application.ReadingTracking;

namespace TextStack.UnitTests;

/// <summary>
/// The locator strings here are the ones from the 2026-08-27 retest, on purpose.
/// `packages/shared/src/reader/locatorSpace.test.ts` quotes the same ones — the
/// two implementations are a contract, and a reader of either should be able to
/// find the other.
/// </summary>
public class LocatorSpaceTests
{
    [Theory]
    [InlineData("page:16", LocatorSpace.Page)]
    [InlineData("page:1", LocatorSpace.Page)]
    [InlineData("scroll:2-the-mom-test:0", LocatorSpace.Scroll)]
    [InlineData("scroll:part-1:chapter-2:subsection:4200", LocatorSpace.Scroll)]
    public void Derive_RecognisesBothSpaces(string locator, string expected)
    {
        Assert.Equal(expected, LocatorSpace.Derive(locator));
    }

    [Theory]
    [InlineData("chapter:1-intro")]   // a BOOKMARK locator — never progress
    [InlineData("epubcfi(/6/4!/4/2)")]
    [InlineData("{\"type\":\"end\"}")]
    [InlineData("")]
    [InlineData(null)]
    public void Derive_ReturnsNullForAnythingElse(string? locator)
    {
        Assert.Null(LocatorSpace.Derive(locator));
    }

    [Fact]
    public void MayReplace_NothingStored_Accepts()
    {
        Assert.True(LocatorSpace.MayReplace(null, "scroll:ch1:0", null));
        Assert.True(LocatorSpace.MayReplace("epubcfi(/6/4)", "page:3", null));
    }

    [Fact]
    public void MayReplace_NullIncoming_Refuses()
    {
        // "I don't know where the reader is" is not "erase where they were".
        // The web client can produce this request: its locator field is optional
        // and JSON.stringify drops undefined.
        Assert.False(LocatorSpace.MayReplace("page:16", null, null));
        Assert.False(LocatorSpace.MayReplace("scroll:ch1:400", null, LocatorSpace.Scroll));
    }

    [Fact]
    public void MayReplace_SameSpaceUndeclared_Accepts()
    {
        // The compatibility case, and the one an over-tight guard breaks. Every
        // build already installed writes scroll-over-scroll for EPUBs and sends
        // no kind at all.
        Assert.True(LocatorSpace.MayReplace("scroll:ch1:0", "scroll:ch2:1200", null));
        Assert.True(LocatorSpace.MayReplace("page:3", "page:16", null));
    }

    [Fact]
    public void MayReplace_CrossSpaceUndeclared_Refuses()
    {
        // The incident, exactly: a reflow close-flush arriving over a PDF page.
        Assert.False(LocatorSpace.MayReplace("page:16", "scroll:2-the-mom-test:0", null));
    }

    [Fact]
    public void MayReplace_CrossSpaceDeclared_Accepts()
    {
        // A PDF that will not render is read as text instead, and that reader is
        // legitimately in scroll space. This is why the rule cannot simply rank
        // page above scroll.
        Assert.True(LocatorSpace.MayReplace("page:16", "scroll:2-the-mom-test:0", LocatorSpace.Scroll));
        Assert.True(LocatorSpace.MayReplace("scroll:ch1:0", "page:16", LocatorSpace.Page));
    }

    [Fact]
    public void MayReplace_DeclarationMustAgreeWithTheLocator()
    {
        // The field is an assertion the payload has to corroborate, not a token
        // that waves any write through.
        Assert.False(LocatorSpace.MayReplace("page:16", "scroll:ch1:0", LocatorSpace.Page));
    }

    [Theory]
    [InlineData("text:2-act-i:4120")]
    [InlineData("anchor:2-act-i:4120")]
    public void Derive_TextSpace_IsStillUnrecognised(string locator)
    {
        // Deliberate, and the assertion is the point. The logical reading position went
        // into a column of its own rather than a third locator space, because rule 3
        // ("same space — accept, declared or not") is the entire compatibility story:
        // introduce `text:` and every already-installed build's `scroll:` write becomes a
        // different space with no declaration, hits rule 5, and is refused. A phone that
        // updated would silently stop a desktop that had not from saving anything.
        //
        // If this test starts failing, someone has added the space anyway. Read ADR-013
        // §2 and ADR-015 before deleting it.
        Assert.Null(LocatorSpace.Derive(locator));
    }
}
