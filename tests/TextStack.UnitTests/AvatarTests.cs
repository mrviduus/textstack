using Api.Endpoints;
using Api.Middleware;
using Application.Identity;
using Application.Common.Interfaces;
using Domain.Identity;
using Infrastructure.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace TextStack.UnitTests;

// #1435: the old avatar was deleted before the new one was saved, so a failed upload left the
// account pointing at a file that no longer existed.
public sealed class AvatarTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "avatar-tests-" + Guid.NewGuid().ToString("N"));
    private readonly LocalFileStorageService _storage;
    private readonly IAuthService _auth = Substitute.For<IAuthService>();
    private readonly IUserRepository _users = Substitute.For<IUserRepository>();
    private readonly IImageOptimizer _optimizer = Substitute.For<IImageOptimizer>();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly UserAccount _reader = new() { Id = Guid.NewGuid(), Email = "reader@example.com" };

    public AvatarTests()
    {
        _storage = new LocalFileStorageService(_root);
        _auth.GetUserByIdAsync(_reader.Id, Arg.Any<CancellationToken>()).Returns(_ => _reader);
        _users.SetPictureAsync(_reader.Id, Arg.Any<string?>(), Arg.Any<CancellationToken>())
            .Returns(call => { _reader.Picture = call.ArgAt<string?>(1); return _reader; });
    }

    [Fact]
    public async Task UploadAvatar_ReaderReplacesTheirPhoto_NewPhotoShownAndOldFileRemoved()
    {
        var oldPhoto = await HasPhoto();
        _optimizer.OptimizeAsync(Arg.Any<byte[]>(), Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(new OptimizedImage([2, 2, 2], "image/jpeg", ".jpg"));

        var result = await Upload();

        Assert.Equal(200, Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode);
        Assert.NotEqual(oldPhoto, _reader.Picture);
        Assert.True(await _storage.ExistsAsync(_reader.Picture!, Ct));
        Assert.False(await _storage.ExistsAsync(oldPhoto, Ct));
    }

    [Fact]
    public async Task UploadAvatar_ImageCannotBeProcessed_OldPhotoStillShown()
    {
        var oldPhoto = await HasPhoto();
        _optimizer.OptimizeAsync(Arg.Any<byte[]>(), Arg.Any<string>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new InvalidOperationException("not an image"));

        await Assert.ThrowsAsync<InvalidOperationException>(Upload);

        Assert.Equal(oldPhoto, _reader.Picture);
        Assert.True(await _storage.ExistsAsync(oldPhoto, Ct));
    }

    private async Task<string> HasPhoto()
    {
        _reader.Picture = await _storage.SaveFileAsync(_reader.Id, "avatar.jpg", new MemoryStream([1, 1, 1]), Ct);
        return _reader.Picture;
    }

    private Task<IResult> Upload()
    {
        var http = new DefaultHttpContext();
        http.Items[McpKeyAuthMiddleware.UserIdItemKey] = _reader.Id;
        var file = new FormFile(new MemoryStream([9, 9, 9]), 0, 3, "file", "me.jpg") { Headers = new HeaderDictionary(), ContentType = "image/jpeg" };
        return ProfileEndpoints.UploadAvatar(file, _auth, _users, _storage, _optimizer,
            NullLogger<IFileStorageService>.Instance, http, Ct);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
