using Application.Common.Interfaces;

namespace Infrastructure.Services;

public class LocalFileStorageService : IFileStorageService
{
    private readonly string _rootPath;

    public LocalFileStorageService(string rootPath)
    {
        _rootPath = rootPath;
        if (!Directory.Exists(_rootPath))
        {
            Directory.CreateDirectory(_rootPath);
        }
    }

    /// <summary>
    /// A file name may carry a sub-folder (<c>assets/x.png</c>) but must land inside the entity's own
    /// directory — a rooted name or <c>..</c> segment is refused rather than written elsewhere.
    /// </summary>
    private static void EnsureInside(string directory, string fullPath)
    {
        var dir = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(fullPath).StartsWith(dir, StringComparison.Ordinal))
            throw new ArgumentException("File name must stay inside the entity's storage directory.");
    }

    public async Task<string> SaveFileAsync(Guid entityId, string fileName, Stream content, CancellationToken ct = default)
    {
        var relativePath = Path.Combine(entityId.ToString()[..2], entityId.ToString(), fileName);
        var fullPath = Path.Combine(_rootPath, relativePath);
        EnsureInside(Path.Combine(_rootPath, entityId.ToString()[..2], entityId.ToString()), fullPath);

        var directory = Path.GetDirectoryName(fullPath)!;
        if (!Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var fileStream = new FileStream(fullPath, FileMode.Create, FileAccess.Write, FileShare.None);
        await content.CopyToAsync(fileStream, ct);

        return relativePath;
    }

    public async Task<string> SaveUserFileAsync(Guid userId, Guid userBookId, string fileName, Stream content, CancellationToken ct = default)
    {
        // Path: users/{userId[0:2]}/{userId}/books/{userBookId}/{fileName}
        var relativePath = Path.Combine("users", userId.ToString()[..2], userId.ToString(), "books", userBookId.ToString(), fileName);
        var fullPath = Path.Combine(_rootPath, relativePath);
        EnsureInside(Path.Combine(_rootPath, "users", userId.ToString()[..2], userId.ToString(), "books", userBookId.ToString()), fullPath);

        var directory = Path.GetDirectoryName(fullPath)!;
        if (!Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await using var fileStream = new FileStream(fullPath, FileMode.Create, FileAccess.Write, FileShare.None);
        await content.CopyToAsync(fileStream, ct);

        return relativePath;
    }

    public Task DeleteUserBookDirectoryAsync(Guid userId, Guid userBookId, CancellationToken ct = default)
    {
        var relativePath = Path.Combine("users", userId.ToString()[..2], userId.ToString(), "books", userBookId.ToString());
        var fullPath = Path.Combine(_rootPath, relativePath);

        if (Directory.Exists(fullPath))
        {
            Directory.Delete(fullPath, recursive: true);
        }

        return Task.CompletedTask;
    }

    public Task DeleteUserDirectoryAsync(Guid userId, CancellationToken ct = default)
    {
        var userIdStr = userId.ToString();
        var shardPrefix = userIdStr[..2];
        var userPath = Path.Combine(_rootPath, "users", shardPrefix, userIdStr);

        if (Directory.Exists(userPath))
        {
            Directory.Delete(userPath, recursive: true);
        }

        // Prune empty shard parent (hygiene — не fail'им если race/permission).
        var shardPath = Path.Combine(_rootPath, "users", shardPrefix);
        try
        {
            if (Directory.Exists(shardPath) && !Directory.EnumerateFileSystemEntries(shardPath).Any())
            {
                Directory.Delete(shardPath, recursive: false);
            }
        }
        catch
        {
            // Best-effort; race с другим delete / permission issue — не критично.
        }

        return Task.CompletedTask;
    }

    public Task<Stream?> GetFileAsync(string path, CancellationToken ct = default)
    {
        var fullPath = GetFullPath(path);
        if (!File.Exists(fullPath))
        {
            return Task.FromResult<Stream?>(null);
        }

        Stream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Task.FromResult<Stream?>(stream);
    }

    public Task<bool> ExistsAsync(string path, CancellationToken ct = default)
    {
        var fullPath = GetFullPath(path);
        return Task.FromResult(File.Exists(fullPath));
    }

    public Task DeleteFileAsync(string path, CancellationToken ct = default)
    {
        var fullPath = GetFullPath(path);
        if (File.Exists(fullPath))
        {
            File.Delete(fullPath);
        }
        return Task.CompletedTask;
    }

    public string GetFullPath(string relativePath)
    {
        return Path.Combine(_rootPath, relativePath);
    }
}
