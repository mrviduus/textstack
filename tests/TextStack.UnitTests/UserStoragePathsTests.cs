using Application.Common;

namespace TextStack.UnitTests;

public class UserStoragePathsTests
{
    [Fact]
    public void Rebase_PathUnderFromDirectory_PrefixReplaced()
    {
        var (g, a, b) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var from = UserStoragePaths.BookDirectory(g, b);
        var to = UserStoragePaths.BookDirectory(a, b);

        Assert.Equal(Path.Combine(to, "assets", "x.png"), UserStoragePaths.Rebase(Path.Combine(from, "assets", "x.png"), from, to));
    }

    [Fact]
    public void Rebase_OtherPathOrNull_Unchanged()
    {
        Assert.Equal("covers/x.jpg", UserStoragePaths.Rebase("covers/x.jpg", "users/ab", "users/cd"));
        Assert.Null(UserStoragePaths.Rebase(null, "users/ab", "users/cd"));
    }
}
