namespace Contracts.UserBooks;

public record UserBookListDto(
    Guid Id,
    string Title,
    string Slug,
    string Language,
    string? Description,
    string? CoverPath,
    string Status,
    string? ErrorMessage,
    int ChapterCount,
    DateTimeOffset CreatedAt
);

public record UserBookDetailDto(
    Guid Id,
    string Title,
    string Slug,
    string Language,
    string? Description,
    string? CoverPath,
    string Status,
    string? ErrorMessage,
    IReadOnlyList<UserChapterSummaryDto> Chapters,
    IReadOnlyList<TocEntryDto>? Toc,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public record UserChapterSummaryDto(
    Guid Id,
    int ChapterNumber,
    string Title,
    int? WordCount
);

public record UserChapterDto(
    Guid Id,
    int ChapterNumber,
    string Title,
    string Html,
    int? WordCount,
    UserChapterNavDto? Previous,
    UserChapterNavDto? Next
);

public record UserChapterNavDto(int ChapterNumber, string Title);

public record TocEntryDto(string Title, int? ChapterNumber, IReadOnlyList<TocEntryDto>? Children);

public record UploadUserBookResponse(Guid UserBookId, Guid JobId, string Status);

public record StorageQuotaDto(long UsedBytes, long LimitBytes, double UsedPercent);
