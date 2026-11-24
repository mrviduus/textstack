namespace Application.Common.Interfaces;

public interface IFileStorageService
{
    Task<string> SaveFileAsync(Guid entityId, string fileName, Stream content, CancellationToken ct = default);
    Task<Stream?> GetFileAsync(string path, CancellationToken ct = default);
    /// <summary>Cheap existence probe — does NOT open the file.</summary>
    Task<bool> ExistsAsync(string path, CancellationToken ct = default);
    Task DeleteFileAsync(string path, CancellationToken ct = default);
    Task DeleteUserDirectoryAsync(Guid userId, CancellationToken ct = default);
    string GetFullPath(string relativePath);
}
