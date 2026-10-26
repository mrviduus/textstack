using Api.Extensions;
using Microsoft.AspNetCore.Http;

namespace TextStack.UnitTests;

public class UserStoragePolicyTests
{
    [Theory]
    [InlineData("/storage/users/ab/abcd/books/1234/original.epub")]
    [InlineData("/storage/users/ab/abcd/books/1234/original.pdf")]
    [InlineData("/storage/users/ab/abcd/books/1234/original.html")]   // clipped web page
    [InlineData("/storage/users/ab/abcd/books/1234/assets/5678.png")] // chapter image: /me/books/{id}/assets
    [InlineData("/storage/users/ab/abcd/books/1234/source.epub")]     // any future file: private by default
    [InlineData("/STORAGE/Users/ab/abcd/books/1234/ORIGINAL.PDF")]
    [InlineData("/storage//users/ab/abcd/books/1234/original.epub")]  // doubled slash after /storage
    [InlineData("/storage/users//ab/abcd/books//1234/original.epub")]
    [InlineData("/storage/users/ab/abcd/books/1234/assets/cover.png")] // a "cover" not at the book root
    public void IsBlocked_PrivateUploadFile_True(string path) =>
        Assert.True(UserStoragePolicy.IsBlocked(new PathString(path)));

    [Theory]
    [InlineData("/storage/users/ab/abcd/books/1234/cover.jpg")]
    [InlineData("/storage/users/ab/abcd/books/1234/COVER.webp")]
    [InlineData("/storage/avatars/g-1.jpg")]
    [InlineData("/storage/ab/abcd/original.epub")]                     // catalog file, not a reader's upload
    [InlineData("/api/me/books/1234/file")]
    public void IsBlocked_PublicFile_False(string path) =>
        Assert.False(UserStoragePolicy.IsBlocked(new PathString(path)));
}
