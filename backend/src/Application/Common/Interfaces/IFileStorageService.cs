namespace Application.Common.Interfaces;

public interface IFileStorageService
{
    Task<string> SaveFileAsync(Guid entityId, string fileName, Stream content, CancellationToken ct = default);
    Task<string> SaveUserFileAsync(Guid userId, Guid userBookId, string fileName, Stream content, CancellationToken ct = default);
    Task<Stream?> GetFileAsync(string path, CancellationToken ct = default);
    /// <summary>Cheap existence probe — does NOT open the file.</summary>
    Task<bool> ExistsAsync(string path, CancellationToken ct = default);
    Task DeleteFileAsync(string path, CancellationToken ct = default);
    Task DeleteUserBookDirectoryAsync(Guid userId, Guid userBookId, CancellationToken ct = default);
    /// <summary>Moves an upload's directory to another owner (guest merge). False when there was nothing to move.</summary>
    Task<bool> MoveUserBookDirectoryAsync(Guid fromUserId, Guid toUserId, Guid userBookId, CancellationToken ct = default);
    Task DeleteUserDirectoryAsync(Guid userId, CancellationToken ct = default);
    string GetFullPath(string relativePath);
}
