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

    public async Task<string> SaveFileAsync(Guid entityId, string fileName, Stream content, CancellationToken ct = default)
    {
        var relativePath = Path.Combine(entityId.ToString()[..2], entityId.ToString(), fileName);
        var fullPath = Path.Combine(_rootPath, relativePath);

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
