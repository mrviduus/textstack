using Contracts.V2;
using Domain.Annotations;
using Domain.Discussion;
using Domain.Library;
using Domain.Reading;
using Domain.Vocabulary;

namespace Application.Sync;

/// <summary>Stored rows as the wire reads them. <c>origin</c> and storage keys never leave the server.</summary>
public static class SyncMapping
{
    public static BookDto ToDto(this Book b) => new(
        b.Id, b.Title, b.Author, b.Language, b.Description, b.Genre, b.PublishedYear, b.Tags, b.CheckpointSavingEnabled,
        b.CoverKey is not null, b.Revision, b.CreatedAt, b.UpdatedAt, b.RemovedAt, b.CurrentFile?.ToDto());

    public static BookFileDto ToDto(this BookFile f) => new(
        f.Id, f.Sha256, f.ByteSize, f.OriginalName, f.Format, f.PageCount, f.Toc, f.IsCurrent,
        f.ServerStorageKey is not null, f.CreatedAt, f.ContentRemovedAt);

    public static ReadingStateDto ToDto(this ReadingState s) => new(
        s.BookId, s.FileId, s.CurrentLocator, s.BookFraction, s.FrontierLocator, s.FrontierFraction,
        s.CompletedAt, s.ClientRecordedAt, s.UpdatedAt, s.Revision, s.ResetRevision);

    public static ReadingSessionDto ToDto(this ReadingSession s) => new(
        s.ClientSessionId, s.BookId, s.StartedAt, s.EndedAt, s.DurationSeconds, s.WordsRead, s.StartPercent, s.EndPercent, s.CreatedAt);

    public static AnnotationDto ToDto(this Annotation a) => new(
        a.Id, a.BookId, a.FileId, a.SelectedText, a.NoteText, a.Locator, a.Color, a.CreatedAt, a.UpdatedAt, a.DeletedAt, a.Revision);

    public static VocabularyWordDto ToDto(this VocabularyWord w, string? example = null) => new(
        w.Id, w.Language, w.Word, w.Translation, w.Definition, w.Stage, w.IntervalDays, w.ConsecutiveCorrect, w.NextReviewAt,
        w.LastReviewedAt, w.CreatedAt, w.UpdatedAt, w.DeletedAt, w.RetiredAt, w.Revision, w.Examples.Select(e => e.ToDto()).ToList(), example);

    public static VocabularyExampleDto ToDto(this VocabularyExample e) => new(
        e.Id, e.OperationId, e.Sentence, e.ContextualTranslation, e.BookId, e.FileId, e.ChapterKey, e.BookTitle, e.CreatedAt);

    public static VocabularyReviewDto ToDto(this VocabularyReview r) => new(
        r.Id, r.OperationId, r.WordId, r.ReviewMode, r.IsCorrect, r.ResponseTimeMs, r.StageBefore, r.StageAfter, r.ClientRecordedAt, r.CreatedAt);

    public static SharedChapterDto ToDto(this SharedChapter s) => new(
        s.Id, s.OperationId, s.BookId, s.FileId, s.ChapterKey, s.ChapterTitle, s.ChapterText, s.NotesSnapshot, s.Language, s.CreatedAt);

    public static CheckpointDto ToDto(this DiscussionCheckpoint c) => new(
        c.Id, c.OperationId, c.BookId, c.FileId, c.ChapterKey, c.SharedChapterId, c.Topic,
        c.ReaderThoughts, c.AssistantSuggestions, c.Conclusions, c.OpenQuestions, c.Language, c.CreatedAt);
}
