namespace TextStack.UnitTests;

/// <summary>A clock a test moves by hand.</summary>
internal sealed class SteppedClock : TimeProvider
{
    // Locked: a worker under test reads it while the test moves it.
    private readonly Lock _gate = new();
    private DateTimeOffset _now = DateTimeOffset.UtcNow;

    public DateTimeOffset Now
    {
        get { lock (_gate) return _now; }
        set { lock (_gate) _now = value; }
    }

    public override DateTimeOffset GetUtcNow() => Now;
}
