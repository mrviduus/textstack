using Domain.Enums;

namespace Domain.Entities;

public class LintResult
{
    public Guid Id { get; set; }
    public Guid EditionId { get; set; }
    public LintSeverity Severity { get; set; }
    public required string Code { get; set; }
    public required string Message { get; set; }
    public int? ChapterNumber { get; set; }
    public int? LineNumber { get; set; }
    public string? Context { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public Edition Edition { get; set; } = null!;
}
