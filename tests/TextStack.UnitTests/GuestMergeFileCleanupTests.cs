using Application.Auth;
using Application.Common.Interfaces;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// Guest merge drops a guest upload whose slug the account already has. The row went; the files under
/// the guest's directory stayed, unreachable once the guest row was deleted. They are now deleted after
/// the merge commits — best-effort, because the sign-in has already succeeded.
/// </summary>
public class GuestMergeFileCleanupTests
{
    [Fact]
    public async Task DeleteUploadFilesBestEffortAsync_OneDeleteFails_OthersStillDeletedAndNoThrow()
    {
        var guestId = Guid.NewGuid();
        var failing = Guid.NewGuid();
        var ok = Guid.NewGuid();
        var storage = new Mock<IFileStorageService>();
        storage.Setup(x => x.DeleteUserBookDirectoryAsync(guestId, failing, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("disk"));

        await AuthService.DeleteUploadFilesBestEffortAsync(
            storage.Object, guestId, [failing, ok], logger: null, CancellationToken.None);

        storage.Verify(x => x.DeleteUserBookDirectoryAsync(guestId, ok, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task DeleteUploadFilesBestEffortAsync_NoDroppedBooks_TouchesNothing()
    {
        var storage = new Mock<IFileStorageService>(MockBehavior.Strict);

        await AuthService.DeleteUploadFilesBestEffortAsync(
            storage.Object, Guid.NewGuid(), [], logger: null, CancellationToken.None);
    }
}
