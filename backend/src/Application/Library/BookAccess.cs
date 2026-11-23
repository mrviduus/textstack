using Application.Sync;
using Domain.Library;

namespace Application.Library;

/// <summary>
/// Library's public port for the other features (ADR-034 rule 4): whether a reader owns a book or a file
/// version of it, and the few book reads and writes they need. Every method is scoped to <c>userId</c>, as
/// on <see cref="ILibraryRepository"/>, whose semantics each one keeps.
/// </summary>
public interface IBookAccess
{
    /// <inheritdoc cref="ILibraryRepository.ExistsAsync"/>
    Task<bool> ExistsAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <inheritdoc cref="ILibraryRepository.GetAsync"/>
    Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <inheritdoc cref="ILibraryRepository.GetFileAsync"/>
    Task<BookFile?> GetFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <inheritdoc cref="ILibraryRepository.FileFormatAsync"/>
    Task<string?> FileFormatAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <inheritdoc cref="LibraryProvenance.MissingBookOrFileAsync"/>
    Task<SyncResult?> MissingBookOrFileAsync(Guid userId, Guid bookId, Guid? fileId, CancellationToken ct);

    /// <inheritdoc cref="ILibraryRepository.SetCheckpointSavingAsync"/>
    Task<Book?> SetCheckpointSavingAsync(Guid userId, Guid bookId, bool enabled, CancellationToken ct);

    /// <inheritdoc cref="ILibraryRepository.ListStorageKeysAsync"/>
    Task<IReadOnlyList<string>> ListStorageKeysAsync(Guid userId, CancellationToken ct);
}

/// <summary><see cref="IBookAccess"/> over the library repository; it delegates, it adds no SQL.</summary>
public sealed class BookAccess(ILibraryRepository library) : IBookAccess
{
    public Task<bool> ExistsAsync(Guid userId, Guid bookId, CancellationToken ct) => library.ExistsAsync(userId, bookId, ct);

    public Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct) => library.GetAsync(userId, bookId, ct);

    public Task<BookFile?> GetFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct) =>
        library.GetFileAsync(userId, bookId, fileId, ct);

    public Task<string?> FileFormatAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct) =>
        library.FileFormatAsync(userId, bookId, fileId, ct);

    public Task<SyncResult?> MissingBookOrFileAsync(Guid userId, Guid bookId, Guid? fileId, CancellationToken ct) =>
        library.MissingBookOrFileAsync(userId, bookId, fileId, ct);

    public Task<Book?> SetCheckpointSavingAsync(Guid userId, Guid bookId, bool enabled, CancellationToken ct) =>
        library.SetCheckpointSavingAsync(userId, bookId, enabled, ct);

    public Task<IReadOnlyList<string>> ListStorageKeysAsync(Guid userId, CancellationToken ct) => library.ListStorageKeysAsync(userId, ct);
}
