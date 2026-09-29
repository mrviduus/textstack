using System.Security.Cryptography;
using System.Text;
using Application.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class ReviewMethodTests
{
    [Fact]
    public void Text_LoadsFromEmbeddedResource()
    {
        Assert.StartsWith("# TextStack chapter review — method v", ReviewMethod.Text);
        Assert.Contains($"method v{ReviewMethod.Version}", ReviewMethod.Text);
    }

    [Theory]
    [InlineData("recall")]
    [InlineData("title")]
    [InlineData("problem")]
    [InlineData("rootCause")]
    [InlineData("rule")]
    [InlineData("highlightIds")]
    [InlineData("question")]
    [InlineData("prompt")]
    [InlineData("answer")]
    [InlineData("applications")]
    [InlineData("openThreads")]
    [InlineData("closedThreadIds")]
    [InlineData("recallRequired")]
    [InlineData("partCount")]
    [InlineData("existingReview")]
    [InlineData("save_chapter_review")]
    public void Text_NamesEveryFieldTheValidatorChecks(string field)
    {
        // The method is the model's only guide to the save; a field it never names is a field the
        // model will guess at, and the validator will refuse.
        Assert.Contains(field, ReviewMethod.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void TextSha256_MatchesText_EditingTheMethodForcesAVersionBump()
    {
        // If this fails you edited ReviewMethod.md: bump ReviewMethod.Version, then paste the new
        // hash into ReviewMethod.TextSha256. Saved reviews are stamped with the version.
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(ReviewMethod.Text)));
        Assert.Equal(ReviewMethod.TextSha256, hash);
    }
}
