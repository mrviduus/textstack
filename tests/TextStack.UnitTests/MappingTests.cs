using System.Text.Json;
using Api.Endpoints;
using Api.Mapping;
using Application.AdminAuth;
using Application.Auth;
using Domain.Entities;
using Domain.Enums;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TextStack.Vocabulary.Contracts;

namespace TextStack.UnitTests;

/// <summary>
/// R4 mapping-layer guard. Two things are proven per extracted projection:
///  (1) JSON snapshot — a fixture entity mapped via the mapping layer serialises to the
///      exact expected JSON (byte-identical field mapping, no accidental drift), and
///  (2) form parity — for DTOs mapped in both forms, the compiled <c>Project</c> expression
///      produces the same JSON as the in-memory <c>ToDto()</c> extension (single source of
///      truth, the two forms can never diverge).
/// A separate SQLite fixture proves every <c>Project</c> used on an IQueryable actually
/// translates to SQL (no silent client-eval). Full SQL translation is re-checked in CI
/// integration against Postgres.
/// </summary>
public class MappingTests
{
    private static readonly Guid G1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid G2 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid G3 = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid G4 = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid G5 = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly DateTimeOffset T1 = new(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
    private static readonly DateTimeOffset T2 = new(2026, 6, 7, 8, 9, 10, TimeSpan.Zero);

    private static string Json<T>(T value) => JsonSerializer.Serialize(value);

    // ---- Fixtures -------------------------------------------------------------

    private static Highlight NewHighlight() => new()
    {
        Id = G1,
        UserId = G2,
        SiteId = G3,
        EditionId = G4,
        ChapterId = G5,
        UserBookId = null,
        UserChapterId = null,
        AnchorJson = "{\"a\":1}",
        Color = "yellow",
        SelectedText = "hello world",
        NoteText = "my note",
        Version = 3,
        CreatedAt = T1,
        UpdatedAt = T2,
        LastReviewedAt = null,
    };

    private static Bookmark NewBookmark() => new()
    {
        Id = G1,
        UserId = G2,
        SiteId = G3,
        EditionId = G4,
        ChapterId = G5,
        Locator = "loc-1",
        Title = "chapter one",
        CreatedAt = T1,
    };

    private static ReadingGoal NewGoal() => new()
    {
        Id = G1,
        UserId = G2,
        SiteId = G3,
        GoalType = "daily_minutes",
        TargetValue = 30,
        Year = 0,
        IsActive = true,
        StreakMinMinutes = 5,
        CreatedAt = T1,
        UpdatedAt = T2,
    };

    private static User NewUser() => new()
    {
        Id = G1,
        Email = "u@example.com",
        Name = "Jane",
        Picture = "pic.png",
        IsGuest = false,
        CreatedAt = T1,
        NativeLanguage = "uk",
    };

    private static AdminUser NewAdmin() => new()
    {
        Id = G1,
        Email = "admin@example.com",
        PasswordHash = "hash",
        Role = AdminRole.Editor,
        CreatedAt = T1,
    };

    private static VocabularyWord NewWord() => new()
    {
        Id = G1,
        UserId = G2,
        SiteId = G3,
        Word = "serendipity",
        Language = "en",
        Translation = "щасливий випадок",
        Definition = "a happy accident",
        Sentence = "It was pure serendipity.",
        BookTitle = "Some Book",
        Hint = "a lucky find",
        Explanation = "when good things happen by chance",
        Distractors = "[\"a\",\"b\"]",
        Stage = 2,
        TotalReviews = 7,
    };

    // ---- JSON snapshots -------------------------------------------------------

    [Fact]
    public void HighlightToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"EditionId\":\"44444444-4444-4444-4444-444444444444\"," +
            "\"ChapterId\":\"55555555-5555-5555-5555-555555555555\"," +
            "\"UserBookId\":null,\"UserChapterId\":null," +
            "\"AnchorJson\":\"{\\u0022a\\u0022:1}\",\"Color\":\"yellow\"," +
            "\"SelectedText\":\"hello world\",\"NoteText\":\"my note\",\"Version\":3," +
            "\"CreatedAt\":\"2026-01-02T03:04:05+00:00\",\"UpdatedAt\":\"2026-06-07T08:09:10+00:00\"}";
        Assert.Equal(expected, Json(NewHighlight().ToDto()));
    }

    [Fact]
    public void BookmarkToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"EditionId\":\"44444444-4444-4444-4444-444444444444\"," +
            "\"ChapterId\":\"55555555-5555-5555-5555-555555555555\"," +
            "\"Locator\":\"loc-1\",\"Title\":\"chapter one\"," +
            "\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"}";
        Assert.Equal(expected, Json(NewBookmark().ToDto()));
    }

    [Fact]
    public void GoalToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"GoalType\":\"daily_minutes\",\"TargetValue\":30,\"Year\":0," +
            "\"StreakMinMinutes\":5,\"UpdatedAt\":\"2026-06-07T08:09:10+00:00\"}";
        Assert.Equal(expected, Json(NewGoal().ToDto()));
    }

    [Fact]
    public void UserToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Email\":\"u@example.com\",\"Name\":\"Jane\",\"Picture\":\"pic.png\"," +
            "\"IsGuest\":false,\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"," +
            "\"NativeLanguage\":\"uk\"}";
        Assert.Equal(expected, Json(NewUser().ToDto()));
    }

    [Fact]
    public void AdminUserToDto_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Email\":\"admin@example.com\",\"Role\":1," +
            "\"CreatedAt\":\"2026-01-02T03:04:05+00:00\"}";
        Assert.Equal(expected, Json(NewAdmin().ToDto()));
    }

    [Fact]
    public void WordForReview_Fixture_MatchesSnapshot()
    {
        var expected =
            "{\"Id\":\"11111111-1111-1111-1111-111111111111\"," +
            "\"Word\":\"serendipity\",\"Language\":\"en\"," +
            "\"Translation\":\"\\u0449\\u0430\\u0441\\u043B\\u0438\\u0432\\u0438\\u0439 \\u0432\\u0438\\u043F\\u0430\\u0434\\u043E\\u043A\"," +
            "\"Definition\":\"a happy accident\"," +
            "\"Sentence\":\"It was pure serendipity.\",\"BookTitle\":\"Some Book\"," +
            "\"Hint\":\"a lucky find\"," +
            "\"Explanation\":\"when good things happen by chance\"," +
            "\"DistractorsJson\":\"[\\u0022a\\u0022,\\u0022b\\u0022]\"," +
            "\"Stage\":2,\"TotalReviews\":7}";
        Assert.Equal(expected, Json(NewWord().ToWordForReview()));
    }

    [Fact]
    public void DistractorPoolProject_Fixture_MatchesSnapshot()
    {
        var project = VocabularyMappings.DistractorPoolProject.Compile();
        var expected = "{\"Word\":\"serendipity\",\"Language\":\"en\"}";
        Assert.Equal(expected, Json(project(NewWord())));
    }

    // Note: no Project-vs-ToDto parity test — ToDto IS Project.Compile() (single
    // source of truth), so such a test is tautological. The JSON snapshots above
    // are the real guard for both forms.

    // ---- EF translation guard (SQLite) ---------------------------------------

    private sealed class MappingDb : DbContext
    {
        public MappingDb(DbContextOptions<MappingDb> options) : base(options) { }

        public DbSet<Highlight> Highlights => Set<Highlight>();
        public DbSet<Bookmark> Bookmarks => Set<Bookmark>();
        public DbSet<ReadingGoal> ReadingGoals => Set<ReadingGoal>();
        public DbSet<VocabularyWord> VocabularyWords => Set<VocabularyWord>();

        protected override void OnModelCreating(ModelBuilder b)
        {
            // Map only the scalar columns the R4 projections touch; drop every navigation
            // and Postgres-only column (pgvector float[]) so the minimal model builds on Sqlite.
            b.Entity<Highlight>(e =>
            {
                e.Ignore(x => x.User); e.Ignore(x => x.Site); e.Ignore(x => x.Edition);
                e.Ignore(x => x.Chapter); e.Ignore(x => x.UserBook); e.Ignore(x => x.UserChapter);
            });
            b.Entity<Bookmark>(e =>
            {
                e.Ignore(x => x.User); e.Ignore(x => x.Site);
                e.Ignore(x => x.Edition); e.Ignore(x => x.Chapter);
            });
            b.Entity<ReadingGoal>(e =>
            {
                e.Ignore(x => x.User); e.Ignore(x => x.Site);
            });
            b.Entity<VocabularyWord>(e =>
            {
                e.Ignore(x => x.User); e.Ignore(x => x.Site); e.Ignore(x => x.Edition);
                e.Ignore(x => x.Chapter); e.Ignore(x => x.UserBook); e.Ignore(x => x.Reviews);
                e.Ignore(x => x.ConceptCluster); e.Ignore(x => x.Embedding);
            });
        }
    }

    private static MappingDb NewMappingDb(SqliteConnection conn)
    {
        var options = new DbContextOptionsBuilder<MappingDb>().UseSqlite(conn).Options;
        var db = new MappingDb(options);
        db.Database.EnsureCreated();
        return db;
    }

    [Fact]
    public void Projects_TranslateToSql_NoClientEval()
    {
        using var conn = new SqliteConnection("Filename=:memory:");
        conn.Open();
        using var db = NewMappingDb(conn);

        db.Highlights.Add(NewHighlight());
        db.Bookmarks.Add(NewBookmark());
        db.ReadingGoals.Add(NewGoal());
        db.VocabularyWords.Add(NewWord());
        db.SaveChanges();

        // Each Select(Project) executes server-side; an un-translatable expression would
        // throw InvalidOperationException here rather than silently client-evaluate.
        var highlight = db.Highlights.Select(HighlightMappings.Project).Single();
        Assert.Equal(Json(NewHighlight().ToDto()), Json(highlight));

        var bookmark = db.Bookmarks.Select(BookmarkMappings.Project).Single();
        Assert.Equal(Json(NewBookmark().ToDto()), Json(bookmark));

        var goal = db.ReadingGoals.Select(ReadingMappings.Project).Single();
        Assert.Equal(Json(NewGoal().ToDto()), Json(goal));

        var pool = db.VocabularyWords.Select(VocabularyMappings.DistractorPoolProject).Single();
        Assert.Equal(new DistractorPoolEntry("serendipity", "en"), pool);
    }
}
