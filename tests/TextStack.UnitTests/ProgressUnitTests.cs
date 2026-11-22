using Application.Reading;

namespace TextStack.UnitTests;

/// <summary>
/// The percent column has been wrong once already — mobile wrote chapter
/// fractions, web wrote book fractions, and a reader saw 10% and 32% for the same
/// book on one screen. The clients agree now, but old builds keep running and
/// their writes cannot be told apart by inspecting the number.
/// </summary>
public class ProgressUnitTests
{
    [Fact]
    public void IsTrusted_BookUnit_True()
    {
        Assert.True(ProgressUnit.IsTrusted(ProgressUnit.Book));
    }

    [Fact]
    public void IsTrusted_MissingUnit_False()
    {
        // The whole point: a client that predates the contract sends no unit, and
        // its percentage is of unknown scale.
        Assert.False(ProgressUnit.IsTrusted(null));
        Assert.False(ProgressUnit.IsTrusted(""));
        Assert.False(ProgressUnit.IsTrusted("   "));
    }

    [Fact]
    public void IsTrusted_ChapterUnit_False()
    {
        // Nothing sends this today. It is here so that if a chapter-scale unit is
        // ever introduced deliberately, it fails this test rather than being
        // silently stored in a column that means something else.
        Assert.False(ProgressUnit.IsTrusted("chapter"));
    }

    [Theory]
    [InlineData("Book")]
    [InlineData("BOOK")]
    public void IsTrusted_IsCaseInsensitive(string unit)
    {
        // A client that capitalises differently is still a client that knows the
        // unit; rejecting it would drop a correct write for a cosmetic reason.
        Assert.True(ProgressUnit.IsTrusted(unit));
    }
}
