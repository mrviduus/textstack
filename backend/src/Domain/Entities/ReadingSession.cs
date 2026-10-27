namespace Domain.Entities;

public class ReadingSession : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid? EditionId { get; set; }
    public Guid? UserBookId { get; set; }
    /// <summary>A deleted upload's file, to re-attach the session on re-upload (#983).</summary>
    public string? DeletedBookSha256 { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset EndedAt { get; set; }
    public int DurationSeconds { get; set; }
    public int WordsRead { get; set; }

    /// <summary>
    /// Where the session began and ended, as a fraction of the WHOLE BOOK (0..1)
    /// — the same unit as <see cref="ReadingProgress.Percent"/>.
    /// <para>
    /// This pair carried the same split as that column: mobile sent a chapter
    /// fraction, web a book fraction. Because
    /// <c>ReadingStatsService</c> and <c>AchievementChecker</c> read
    /// <see cref="EndPercent"/> &gt;= 0.99 as "finished a book", every chapter a
    /// mobile reader finished minted a book-completion — inflating the finished
    /// count and unlocking reading achievements early. <c>WordsRead</c> is
    /// derived from the delta, so it was inflated by the same mistake.
    /// </para>
    /// </summary>
    public double StartPercent { get; set; }

    /// <inheritdoc cref="StartPercent"/>
    public double EndPercent { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition? Edition { get; set; }
    public UserBook? UserBook { get; set; }
}
