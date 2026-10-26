using Api.Extensions;
using Microsoft.AspNetCore.Http;

namespace TextStack.UnitTests;

public class UploadOriginalPolicyTests
{
    [Theory]
    [InlineData("/storage/users/ab/abcd/books/1234/original.epub")]
    [InlineData("/storage/users/ab/abcd/books/1234/original.pdf")]
    [InlineData("/storage/users/ab/abcd/books/1234/original.html")]   // clipped web page
    [InlineData("/STORAGE/Users/ab/abcd/books/1234/ORIGINAL.PDF")]
    [InlineData("/storage/users//ab/abcd/books//1234/original.epub")]  // doubled slashes
    public void IsBlocked_UploadOriginal_True(string path) =>
        Assert.True(UploadOriginalPolicy.IsBlocked(new PathString(path)));

    [Theory]
    [InlineData("/storage/users/ab/abcd/books/1234/cover.jpg")]
    [InlineData("/storage/users/ab/abcd/books/1234/images/fig1.png")]
    [InlineData("/storage/ab/abcd/original.epub")]                     // catalog file, not a reader's upload
    [InlineData("/storage/users/ab/abcd/avatar.jpg")]
    [InlineData("/api/me/books/1234/file")]
    public void IsBlocked_Other_False(string path) =>
        Assert.False(UploadOriginalPolicy.IsBlocked(new PathString(path)));
}
