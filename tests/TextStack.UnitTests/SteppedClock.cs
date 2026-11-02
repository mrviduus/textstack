namespace TextStack.UnitTests;

/// <summary>A clock a test moves by hand.</summary>
internal sealed class SteppedClock : TimeProvider
{
    public DateTimeOffset Now = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow() => Now;
}
