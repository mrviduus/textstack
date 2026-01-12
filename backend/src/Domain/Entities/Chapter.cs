using NpgsqlTypes;

namespace Domain.Entities;

public class Chapter
{
    public Guid Id { get; set; }
    public Guid EditionId { get; set; }
    public int ChapterNumber { get; set; }
    public string? Slug { get; set; }
    public required string Title { get; set; }
    public required string Html { get; set; }
    public required string PlainText { get; set; }
    public int? WordCount { get; set; }

    /// <summary>Original chapter number before splitting (for TOC grouping)</summary>
    public int? OriginalChapterNumber { get; set; }

    /// <summary>Part number within original chapter (1, 2, 3... or null if not split)</summary>
    public int? PartNumber { get; set; }

    /// <summary>Total parts the original chapter was split into (for "Part 2 of 5" display)</summary>
    public int? TotalParts { get; set; }

    public NpgsqlTsVector SearchVector { get; set; } = null!;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public Edition Edition { get; set; } = null!;
    public ICollection<ReadingProgress> ReadingProgresses { get; set; } = [];
    public ICollection<Bookmark> Bookmarks { get; set; } = [];
    public ICollection<Note> Notes { get; set; } = [];
}
