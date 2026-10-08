using System.Collections;
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

namespace TextStack.UnitTests.Fakes;

/// <summary>
/// In-memory <see cref="DbSet{T}"/> backed by a <see cref="List{T}"/> with working async LINQ
/// (via <see cref="TestAsyncEnumerable{T}"/>). Supports:
/// <c>Where</c>/<c>OrderBy</c>/<c>Select</c>/<c>Take</c> + <c>AnyAsync</c>/<c>FirstOrDefaultAsync</c>/<c>ToListAsync</c>
/// and <c>Add</c>/<c>Remove</c>/<c>RemoveRange</c>. No change-tracking — <c>Add</c> just appends to the backing list (callers
/// read back via the same list after SaveChanges).
/// </summary>
internal sealed class FakeDbSet<T>(List<T> store) : DbSet<T>, IQueryable<T>, IAsyncEnumerable<T>
    where T : class
{
    private readonly TestAsyncEnumerable<T> _query = new(store);

    public List<T> Store => store;

    public override Microsoft.EntityFrameworkCore.ChangeTracking.EntityEntry<T> Add(T entity)
    {
        store.Add(entity);
        return null!; // worker discards the returned entry
    }

    public override Microsoft.EntityFrameworkCore.ChangeTracking.EntityEntry<T> Remove(T entity)
    {
        store.Remove(entity);
        return null!;
    }

    public override void RemoveRange(IEnumerable<T> entities)
    {
        foreach (var e in entities.ToList()) store.Remove(e);
    }

    public override Microsoft.EntityFrameworkCore.Metadata.IEntityType EntityType =>
        throw new NotSupportedException();

    IEnumerator<T> IEnumerable<T>.GetEnumerator() => store.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => store.GetEnumerator();
    public IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken ct = default) =>
        ((IAsyncEnumerable<T>)_query).GetAsyncEnumerator(ct);

    public Type ElementType => ((IQueryable<T>)_query).ElementType;
    public Expression Expression => ((IQueryable<T>)_query).Expression;
    public IQueryProvider Provider => ((IQueryable<T>)_query).Provider;
}
