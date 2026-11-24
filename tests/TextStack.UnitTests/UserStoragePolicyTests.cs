using Api.Extensions;
using Microsoft.AspNetCore.Http;

namespace TextStack.UnitTests;

public class UserStoragePolicyTests
{
    [Theory]
    [InlineData("/storage/users/ab/abcd/books/1234/original.epub")]
    [InlineData("/storage/users/ab/abcd/books/1234/assets/5678.png")]
    [InlineData("/storage/users/ab/abcd/books/1234/cover.jpg")]       // #956: the cover's door is /me/v2/books/{id}/cover
    [InlineData("/storage/users/ab/abcd/books/1234/COVER.webp")]
    [InlineData("/storage/users/ab/abcd/avatar.jpg")]                 // anything under users/, not only books
    [InlineData("/storage/users")]
    [InlineData("/STORAGE/Users/ab/abcd/books/1234/cover.jpg")]
    [InlineData("/storage//users/ab/abcd/books/1234/cover.jpg")]      // doubled slash after /storage
    [InlineData("/storage/library/ab/abcd/1234/5678.epub")]           // V2: a book, its cover and parts are /me/v2 only
    [InlineData("/storage/library/ab/abcd/1234/cover.jpg")]
    [InlineData("/storage//Library/ab/abcd/1234/5678.pdf")]
    [InlineData("/storage/uploads/abcd/5678/00000.part")]
    [InlineData("/storage//Uploads/abcd/5678/00000.part")]
    public void IsBlocked_PrivateStoragePath_True(string path) =>
        Assert.True(UserStoragePolicy.IsBlocked(new PathString(path)));

    [Theory]
    [InlineData("/storage/avatars/g-1.jpg")]
    [InlineData("/storage/ab/abcd/avatar.jpg")]                        // SaveFileAsync's shard layout
    [InlineData("/storage/usersx/ab/cover.jpg")]                       // a segment, not a prefix
    [InlineData("/api/me/v2/books/1234/cover")]
    public void IsBlocked_PublicFile_False(string path) =>
        Assert.False(UserStoragePolicy.IsBlocked(new PathString(path)));
}
