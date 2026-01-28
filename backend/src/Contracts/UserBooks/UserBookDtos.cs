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
    string? Slug,
    string Title,
    int? WordCount
);

public record UserChapterDto(
    Guid Id,
    int ChapterNumber,
    string? Slug,
    string Title,
    string Html,
    int? WordCount,
    UserChapterNavDto? Previous,
    UserChapterNavDto? Next
);

public record UserChapterNavDto(int ChapterNumber, string? Slug, string Title);

public record TocEntryDto(string Title, int? ChapterNumber, IReadOnlyList<TocEntryDto>? Children);

public record UploadUserBookResponse(Guid UserBookId, Guid JobId, string Status);

public record StorageQuotaDto(long UsedBytes, long LimitBytes, double UsedPercent);

public record UserBookProgressDto(
    string? ChapterSlug,
    string? Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt
);

public record UpsertUserBookProgressRequest(
    string ChapterSlug,
    string? Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt
);

public record UserBookBookmarkDto(
    Guid Id,
    Guid ChapterId,
    string? ChapterSlug,
    string Locator,
    string? Title,
    DateTimeOffset CreatedAt
);

public record CreateUserBookBookmarkRequest(
    Guid ChapterId,
    string Locator,
    string? Title
);
