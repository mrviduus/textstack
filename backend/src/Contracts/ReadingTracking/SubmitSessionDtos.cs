namespace Contracts.ReadingTracking;

// A legacy reading session (POST /me/reading/sessions, gone): legacy AuthService still merges guest rows of it.
public record SubmitSessionRequest(
    Guid? EditionId,
    Guid? UserBookId,
    DateTimeOffset StartedAt,
    DateTimeOffset EndedAt,
    int DurationSeconds,
    int WordsRead,
    double StartPercent,
    double EndPercent
);
