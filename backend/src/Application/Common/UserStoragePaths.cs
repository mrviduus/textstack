namespace Application.Common;

/// <summary>
/// Where an upload's files live, relative to the storage root. One definition, because the path
/// is also STORED (<c>UserBookFile.StoragePath</c>, <c>UserBook.CoverPath</c>) and a guest merge
/// has to rewrite those when it moves the directory to the account.
/// </summary>
public static class UserStoragePaths
{
    /// <summary><c>users/{id[0:2]}/{id}/books/{bookId}</c>.</summary>
    public static string BookDirectory(Guid userId, Guid userBookId)
    {
        var id = userId.ToString();
        return Path.Combine("users", id[..2], id, "books", userBookId.ToString());
    }

    /// <summary>
    /// <paramref name="path"/> with its <paramref name="fromDirectory"/> prefix replaced by
    /// <paramref name="toDirectory"/>; any other path (or null) unchanged.
    /// </summary>
    public static string? Rebase(string? path, string fromDirectory, string toDirectory) =>
        path is not null && path.StartsWith(fromDirectory, StringComparison.Ordinal)
            ? toDirectory + path[fromDirectory.Length..]
            : path;
}
