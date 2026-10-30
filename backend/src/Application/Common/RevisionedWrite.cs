namespace Application.Common;

/// <summary>
/// The result of a write guarded by <c>revision</c> (v2-sync-protocol.md): a stale write is not an
/// error, it loses. <see cref="Accepted"/>: <see cref="Current"/> is the stored row with its new
/// revision. Otherwise <see cref="Current"/> is what is stored instead (null: nothing, or not the user's).
/// </summary>
public sealed record RevisionedWrite<T>(bool Accepted, T? Current);
