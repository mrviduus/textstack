using Application.UserBooks;

namespace TextStack.UnitTests;

public class UserBookTitleFromFileNameTests
{
    [Theory]
    [InlineData("AI Engineering (Chip Huyen) (z-library.sk, 1lib.sk, z-lib.sk).pdf", "AI Engineering (Chip Huyen)")]
    [InlineData("The C Programming Language (2nd Edition).epub", "The C Programming Language (2nd Edition)")]
    // Nothing left after cleaning → keep the raw name rather than an empty title.
    [InlineData("(z-lib.sk).pdf", "(z-lib.sk)")]
    public void TitleFromFileName_VariousNames_ReturnsCleanedOrRaw(string fileName, string expected)
    {
        Assert.Equal(expected, UserBookService.TitleFromFileName(fileName));
    }
}
