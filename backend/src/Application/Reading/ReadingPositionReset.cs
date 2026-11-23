using Npgsql;

namespace Application.Reading;

/// <summary>Reading's public port for the other features (ADR-034 rule 4): drop the position taken in a file version that was replaced.</summary>
public interface IReadingPositionReset
{
    /// <inheritdoc cref="IReadingStateRepository.DeleteForFileAsync"/>
    Task<bool> DeleteForFileAsync(Guid userId, Guid bookId, Guid fileId, NpgsqlTransaction? tx, CancellationToken ct);
}

/// <summary><see cref="IReadingPositionReset"/> over the reading-state repository; it delegates (in the caller's transaction), it adds no SQL.</summary>
public sealed class ReadingPositionReset(IReadingStateRepository states) : IReadingPositionReset
{
    public Task<bool> DeleteForFileAsync(Guid userId, Guid bookId, Guid fileId, NpgsqlTransaction? tx, CancellationToken ct) =>
        states.DeleteForFileAsync(userId, bookId, fileId, tx, ct);
}
