using Npgsql;

namespace Application.Common;

/// <summary>
/// Begins a V2 unit of work (plan §6, #1067): a use case that must write two aggregates atomically
/// opens one and passes <see cref="V2Transaction.Transaction"/> to each repository method that takes
/// <c>NpgsqlTransaction? tx</c> (data-access.md rule 6).
/// </summary>
public interface IV2UnitOfWork
{
    Task<V2Transaction> BeginAsync(CancellationToken ct);
}

/// <summary>
/// An open transaction and the pooled connection it runs on. A wrapper because disposing an
/// <see cref="NpgsqlTransaction"/> does not return its connection to the pool (it would leak), and
/// after a commit its <see cref="NpgsqlTransaction.Connection"/> is null: this keeps both and
/// disposes both.
/// Disposed without <see cref="CommitAsync"/>, everything rolls back. A <see cref="Join"/>ed one
/// belongs to the caller: commit and dispose are left to them.
/// </summary>
public sealed class V2Transaction : IAsyncDisposable
{
    private readonly NpgsqlConnection? _owned;

    public V2Transaction(NpgsqlConnection connection, NpgsqlTransaction transaction) =>
        (_owned, Transaction) = (connection, transaction);

    private V2Transaction(NpgsqlTransaction joined) => Transaction = joined;

    /// <summary>A repository method's view of its caller's transaction.</summary>
    public static V2Transaction Join(NpgsqlTransaction transaction) => new(transaction);

    public NpgsqlTransaction Transaction { get; }

    public NpgsqlConnection Connection => _owned ?? Transaction.Connection!;

    public Task CommitAsync(CancellationToken ct) => _owned is null ? Task.CompletedTask : Transaction.CommitAsync(ct);

    public async ValueTask DisposeAsync()
    {
        if (_owned is null) return;
        await Transaction.DisposeAsync();
        await _owned.DisposeAsync();
    }
}
