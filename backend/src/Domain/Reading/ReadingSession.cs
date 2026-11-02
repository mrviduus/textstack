namespace Domain.Reading;

/// <summary>
/// One reading interval of one user (V2 table <c>reading_sessions</c>), for stats and streaks. An
/// append-only fact keyed by the client's <see cref="ClientSessionId"/>: the first write wins, a
/// replay changes nothing. It outlives its book (<see cref="BookId"/> becomes null on a hard delete).
/// </summary>
public class ReadingSession
{
    /// <summary>Set by the server; ignored on write.</summary>
    public Guid Id { get; set; }

    public Guid UserId { get; set; }
    public Guid ClientSessionId { get; set; }
    public Guid? BookId { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset EndedAt { get; set; }
    public int DurationSeconds { get; set; }
    public int WordsRead { get; set; }

    /// <summary>Fractions of the book, 0..1; the column names are legacy.</summary>
    public decimal StartPercent { get; set; }

    public decimal EndPercent { get; set; }

    /// <summary>Set by the server; ignored on write.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}
