using Contracts.V2;
using Domain.Annotations;
using Domain.Library;
using Domain.Reading;

namespace Application.Sync;

/// <summary>Stored rows as the wire reads them. <c>origin</c> and storage keys never leave the server.</summary>
public static class SyncMapping
{
    public static BookDto ToDto(this Book b) => new(
        b.Id, b.Title, b.Author, b.Language, b.Description, b.Genre, b.PublishedYear, b.Tags, b.CheckpointSavingEnabled,
        b.CoverKey is not null, b.Revision, b.CreatedAt, b.UpdatedAt, b.RemovedAt, b.CurrentFile?.ToDto());

    public static BookFileDto ToDto(this BookFile f) => new(
        f.Id, f.Sha256, f.ByteSize, f.OriginalName, f.Format, f.PageCount, f.Toc, f.IsCurrent,
        f.ServerStorageKey is not null, f.CreatedAt);

    public static ReadingStateDto ToDto(this ReadingState s) => new(
        s.BookId, s.FileId, s.CurrentLocator, s.BookFraction, s.FrontierLocator, s.FrontierFraction,
        s.CompletedAt, s.ClientRecordedAt, s.UpdatedAt, s.Revision, s.ResetRevision);

    public static ReadingSessionDto ToDto(this ReadingSession s) => new(
        s.ClientSessionId, s.BookId, s.StartedAt, s.EndedAt, s.DurationSeconds, s.WordsRead, s.StartPercent, s.EndPercent, s.CreatedAt);

    public static AnnotationDto ToDto(this Annotation a) => new(
        a.Id, a.BookId, a.FileId, a.SelectedText, a.NoteText, a.Locator, a.Color, a.CreatedAt, a.UpdatedAt, a.DeletedAt, a.Revision);
}
