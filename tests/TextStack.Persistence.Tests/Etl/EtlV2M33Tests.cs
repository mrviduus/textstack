using System.Text.Json;
using Application.Vocabulary;
using Domain.Vocabulary;
using Infrastructure.Persistence.Etl;
using Infrastructure.Persistence.Etl.Steps;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// M3.3's mappers (catalog pairs, vocabulary, insights, sessions) on a legacy fixture that mirrors
/// production's shapes: case-variant words, a pair with no progress, a deleted edition, sessions on
/// deleted books and on a session-only pair, a review question with a legacy hash, orphans. V2 users
/// (and the one upload's book) are seeded directly: they are M3.2's.
/// </summary>
public sealed class EtlV2M33Tests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2)
{
    private static readonly Guid Alice = Guid.Parse("a11ce000-0000-4000-8000-000000000001");
    private static readonly Guid Bob = Guid.Parse("b0b00000-0000-4000-8000-000000000002");
    private static readonly Guid Carol = Guid.Parse("ca201000-0000-4000-8000-000000000003"); // not in V2
    private static readonly Guid CleanCode = Guid.Parse("bbbbbbbb-0003-0003-0003-000000000002");
    private static readonly Guid DesignPatterns = Guid.Parse("bbbbbbbb-0004-0004-0004-000000000002");
    private static readonly Guid Doomed = Guid.Parse("dddddddd-0000-4000-8000-000000000001"); // deleted below
    private static readonly Guid Gone = Guid.Parse("dddddddd-0000-4000-8000-000000000002"); // never existed
    private static readonly Guid Upload = Guid.Parse("0b000000-0000-4000-8000-000000000001");
    private const string MeaningfulNames = "43b12d1f-7aef-4645-a661-e4bc0239d2c7";
    private const string DeletedSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static EtlV2Step[] M33 => [.. EtlV2.Steps];

    private const string Fixture = $$"""
        INSERT INTO users (id, email, created_at, is_guest, google_subject) VALUES
            ('a11ce000-0000-4000-8000-000000000001', 'alice@test', '2026-01-01Z', false, NULL),
            ('b0b00000-0000-4000-8000-000000000002', 'bob@test', '2026-01-01Z', true, NULL),
            ('ca201000-0000-4000-8000-000000000003', 'carol@test', '2026-01-01Z', false, NULL);
        INSERT INTO works (id, slug, created_at, site_id) VALUES ('dddddddd-0000-4000-8000-0000000000ff', 'doomed', now(), '11111111-1111-1111-1111-111111111111');
        INSERT INTO editions (id, work_id, language, slug, title, status, is_public_domain, created_at, updated_at, site_id)
            VALUES ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-0000000000ff', 'en', 'doomed', 'Doomed', 1, true, now(), now(), '11111111-1111-1111-1111-111111111111');
        INSERT INTO user_books (id, user_id, title, slug, language, status, created_at, updated_at)
            VALUES ('0b000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', 'My Upload', 'my-upload', 'en', 1, now(), now());

        -- Pairs: alice+Clean Code by the library only (no progress); alice+Design Patterns by progress only;
        -- bob+Clean Code by a highlight; bob's shelf names an edition that never existed; carol is not in V2.
        INSERT INTO user_libraries (id, user_id, edition_id, created_at) VALUES
            (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'bbbbbbbb-0003-0003-0003-000000000002', '2026-02-01Z'),
            (gen_random_uuid(), 'ca201000-0000-4000-8000-000000000003', 'bbbbbbbb-0003-0003-0003-000000000002', '2026-02-01Z'),
            (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '2026-02-01Z');
        INSERT INTO reading_progresses (id, user_id, edition_id, chapter_id, locator, updated_at, site_id)
            VALUES (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'bbbbbbbb-0004-0004-0004-000000000002', '{{MeaningfulNames}}', 'x', '2026-02-03Z', '11111111-1111-1111-1111-111111111111');
        INSERT INTO highlights (id, user_id, site_id, edition_id, anchor_json, color, selected_text, note_text, version, created_at, updated_at) VALUES
            ('41000000-0000-4000-8000-000000000001', 'b0b00000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0003-0003-0003-000000000002', '{}', 'green', 'Clean code reads like prose', 'so true', 3, '2026-02-05Z', '2026-02-06Z'),
            ('41000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-4000-8000-000000000001', '{}', 'yellow', 'lost with its edition', NULL, 1, '2026-02-05Z', '2026-02-05Z');
        INSERT INTO collections (id, user_id, name, sort_order, created_at, updated_at) VALUES ('c0000000-0000-4000-8000-000000000001', 'b0b00000-0000-4000-8000-000000000002', 'Shelf', 0, now(), now());
        INSERT INTO book_collections (collection_id, book_id, book_type, added_at) VALUES ('c0000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002', 'savedbook', now());

        -- Vocabulary: "Run"/"run"/" RUN " (language "EN") collide; the survivor has the most reviews.
        -- "Walk"/"walk" tie on reviews: the newer update wins.
        INSERT INTO vocabulary_words (id, user_id, site_id, word, language, translation, edition_id, chapter_id, user_book_id, sentence, book_title,
            stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, created_at, updated_at, is_retired, retired_at) VALUES
            ('70000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'Run', 'en', 'бігти', 'bbbbbbbb-0003-0003-0003-000000000002', '{{MeaningfulNames}}', NULL, 'Run, Forest!', 'Clean Code',
                1, 1, 1, '2026-03-01Z', '2026-02-20Z', 2, 1, '2026-02-10Z', '2026-02-20Z', false, NULL),
            ('70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'run', 'en', 'бігати', NULL, NULL, '0b000000-0000-4000-8000-000000000001', 'I run daily.', 'My Upload',
                4, 0.3333333333333333, 3, '2026-03-05Z', '2026-02-25Z', 5, 4, '2026-02-11Z', '2026-02-25Z', true, NULL),
            ('70000000-0000-4000-8000-000000000003', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', ' RUN ', 'EN', NULL, 'dddddddd-0000-4000-8000-000000000001', NULL, NULL, 'RUN!', 'Doomed',
                0, 0, 0, '2026-03-01Z', NULL, 0, 0, '2026-02-12Z', '2026-02-12Z', false, NULL),
            ('70000000-0000-4000-8000-000000000004', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'Walk', 'en', NULL, NULL, NULL, NULL, NULL, NULL,
                2, 2.5, 2, '2026-03-01Z', NULL, 1, 1, '2026-02-12Z', '2026-02-14Z', false, NULL),
            ('70000000-0000-4000-8000-000000000005', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'walk', 'en', NULL, NULL, NULL, NULL, '   ', NULL,
                3, 4, 3, '2026-03-02Z', NULL, 1, 1, '2026-02-12Z', '2026-02-15Z', false, NULL),
            ('70000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'orphan', 'en', NULL, NULL, NULL, NULL, NULL, NULL,
                0, 0, 0, '2026-03-01Z', NULL, 0, 0, '2026-02-12Z', '2026-02-12Z', false, NULL);
        INSERT INTO vocabulary_reviews (id, vocabulary_word_id, user_id, site_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, created_at) VALUES
            ('72000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'flashcard', true, 900, 0, 1, '2026-02-20 10:00:00.123456Z'),
            ('72000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'multiple_choice', false, 1500, 4, 3, '2026-02-25Z'),
            ('72000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'flashcard', true, 700, 3, 4, '2026-02-26Z'),
            ('72000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'flashcard', true, 700, 0, 1, '2026-02-26Z');

        -- Insights: a chapter review on a catalog pair whose question keeps a legacy hash; one on the upload; carol's.
        INSERT INTO book_insight (id, user_id, site_id, edition_id, user_book_id, chapter_slug, text, question, review_json, created_at, updated_at) VALUES
            ('15000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, 'meaningful-names', 'Names matter', 'Why names?', '{"b": [1, 2.5], "a": "x"}', '2026-02-07Z', '2026-02-08Z'),
            ('15000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', NULL, '0b000000-0000-4000-8000-000000000001', NULL, 'Mine', NULL, NULL, '2026-02-07Z', '2026-02-07Z'),
            ('15000000-0000-4000-8000-000000000003', 'ca201000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, NULL, 'Carol''s', NULL, NULL, '2026-02-07Z', '2026-02-07Z');
        INSERT INTO review_question (id, user_id, site_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at) VALUES
            ('16000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '15000000-0000-4000-8000-000000000001', 0, 'Why?', 'Because.', 'deadbeefdeadbeef', 2, 1.5, 1,
                '2026-03-01Z', '2026-02-09Z', 3, 2, false, '2026-02-07Z', '2026-02-09Z');

        -- Sessions: on a pair; on the doomed edition; bob on a session-only pair; on a deleted upload; carol's.
        INSERT INTO reading_sessions (id, user_id, site_id, edition_id, user_book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, deleted_book_sha256, created_at) VALUES
            ('5e000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, '2026-02-01 10:00Z', '2026-02-01 10:10Z', 600, 2000, 0, 0.1, NULL, '2026-02-01 10:10Z'),
            ('5e000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-4000-8000-000000000001', NULL, '2026-02-02 10:00Z', '2026-02-02 10:05Z', 300, 900, 0.1, 0.2, NULL, '2026-02-02 10:05Z'),
            ('5e000000-0000-4000-8000-000000000003', 'b0b00000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0004-0004-0004-000000000002', NULL, '2026-02-02 10:00Z', '2026-02-02 10:01Z', 60, 100, 0, 0.01, NULL, '2026-02-02 10:01Z'),
            ('5e000000-0000-4000-8000-000000000004', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', NULL, NULL, '2026-02-03 10:00Z', '2026-02-03 10:02Z', 120, 300, 0.5, 0.6, '{{DeletedSha}}', '2026-02-03 10:02Z'),
            ('5e000000-0000-4000-8000-000000000005', 'a11ce000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', NULL, '0b000000-0000-4000-8000-000000000001', '2026-02-04 10:00Z', '2026-02-04 10:03Z', 180, 400, 0, 0.3, NULL, '2026-02-04 10:03Z'),
            ('5e000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', NULL, NULL, '2026-02-04 10:00Z', '2026-02-04 10:03Z', 180, 400, 0, 0.3, NULL, '2026-02-04 10:03Z');

        -- The doomed edition goes: its library row cascades away, the highlight, word and session keep no edition.
        DELETE FROM editions WHERE id = 'dddddddd-0000-4000-8000-000000000001';
        """;

    // M3.2's rows, seeded: alice and bob (not carol), and alice's upload.
    private const string V2Users = """
        INSERT INTO users (id, email, created_at, is_guest) VALUES
            ('a11ce000-0000-4000-8000-000000000001', 'alice@test', '2026-01-01Z', false),
            ('b0b00000-0000-4000-8000-000000000002', 'bob@test', '2026-01-01Z', true);
        INSERT INTO books (id, user_id, title, origin) VALUES ('0b000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', 'My Upload', '{"kind":"upload"}');
        """;

    private async Task<EtlV2Options> NewPairAsync(bool dryRun = false, string? extra = null)
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        await ExecAsync(source, Fixture + (extra ?? ""));
        var target = await V2.Databases.NewV2Async(name);
        await ExecAsync(target, V2Users);
        return new EtlV2Options(source, target, dryRun);
    }

    private async Task<string> DumpAsync(string target) => await ScalarAsync<string>(target, """
        SELECT concat_ws(E'\n',
            (SELECT string_agg(to_jsonb(b)::text, E'\n' ORDER BY id) FROM books b),
            (SELECT string_agg(to_jsonb(a)::text, E'\n' ORDER BY id) FROM annotations a),
            (SELECT string_agg(to_jsonb(w)::text, E'\n' ORDER BY id) FROM vocabulary_words w),
            (SELECT string_agg(to_jsonb(e)::text, E'\n' ORDER BY id) FROM vocabulary_examples e),
            (SELECT string_agg(to_jsonb(r)::text, E'\n' ORDER BY id) FROM vocabulary_reviews r),
            (SELECT string_agg(to_jsonb(i)::text, E'\n' ORDER BY id) FROM book_insight i),
            (SELECT string_agg(to_jsonb(q)::text, E'\n' ORDER BY id) FROM review_question q),
            (SELECT string_agg(to_jsonb(s)::text, E'\n' ORDER BY id) FROM reading_sessions s))
        """);

    [Fact]
    public async Task RunAsync_ProductionShapes_CarriesEveryAggregateAndValidates()
    {
        var options = await NewPairAsync();

        var report = await EtlV2.RunAsync(options, M33, Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        string[] named = ["catalog.intent-pairs-complete", "vocabulary.srs-fields-equal", "vocabulary.review-counts-equal",
            "insights.hashes-equal", "sessions.seconds-per-user-equal", "unknown-user-ids"];
        Assert.All(named, n => Assert.Contains(report.Checks, c => c.Name == n));
        Assert.Equal("succeeded", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs"));
        var t = options.Target;

        // Books: alice ×2 (library only; progress only), bob ×1 (highlight). Not carol's, not the gone edition's.
        Assert.Equal(3, await ScalarAsync<long>(t, "SELECT count(*) FROM books WHERE origin->>'kind' = 'catalog'"));
        var aliceClean = EtlV2Ids.CatalogBook(Alice, CleanCode);
        Assert.Equal("Clean Code|Robert C. Martin|en|clean-code|2026-02-01 00:00:00+00", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', title, author, language, origin->>'editionSlug', created_at) FROM books WHERE id = @id", new { id = aliceClean }));
        Assert.Equal("Erich Gamma", await ScalarAsync<string>(t, "SELECT author FROM books WHERE id = @id", new { id = EtlV2Ids.CatalogBook(Alice, DesignPatterns) }));
        Assert.Equal(0, await ScalarAsync<long>(t, "SELECT count(*) FROM book_files"));
        Assert.Equal(0, await ScalarAsync<long>(t, "SELECT count(*) FROM reading_state"));

        // Bob's highlight: unanchored, on his pair, revision = version.
        Assert.Equal($"{EtlV2Ids.CatalogBook(Bob, CleanCode)}|green|so true|3|t", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', book_id, color, note_text, revision, locator IS NULL AND file_id IS NULL) FROM annotations"));

        // Vocabulary: "run" (5 reviews) survives the three-way merge, language normalized; "walk" (newer) beats "Walk".
        Assert.Equal("70000000-0000-4000-8000-000000000002|en|run|run|бігати|4|0.3333333333333333|3|t", await ScalarAsync<string>(t, """
            SELECT string_agg(concat_ws('|', id, language, word, word_key, translation, stage, interval_days, consecutive_correct, retired_at IS NOT NULL), ';' ORDER BY id)
            FROM vocabulary_words WHERE word_key = 'run'
            """));
        Assert.Equal("70000000-0000-4000-8000-000000000005|walk|4", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', id, word, interval_days) FROM vocabulary_words WHERE word_key = 'walk'"));
        Assert.Equal(2, await ScalarAsync<long>(t, "SELECT count(*) FROM vocabulary_words"));
        // Three sentences (a blank one is no example), all on the survivor: the catalog chapter keyed, the
        // upload's book kept, the deleted edition's with no book but its title snapshot.
        Assert.Equal(
            $"{aliceClean}|meaningful-names|Clean Code|Run, Forest!;{Upload}|My Upload|I run daily.;Doomed|RUN!",
            await ScalarAsync<string>(t, """
                SELECT string_agg(concat_ws('|', book_id, chapter_key, book_title, sentence), ';' ORDER BY created_at)
                FROM vocabulary_examples WHERE word_id = '70000000-0000-4000-8000-000000000002'
                """));
        var example = await ScalarAsync<string>(t, "SELECT concat_ws('|', operation_id, payload_sha256) FROM vocabulary_examples WHERE sentence = 'I run daily.'");
        var hash = VocabularyPayloads.ExampleSha256(new VocabularyWord { Language = "en", WordKey = "run" },
            new VocabularyExample { BookId = Upload, BookTitle = "My Upload", Sentence = "I run daily." });
        Assert.Equal($"{EtlV2Ids.Operation(Guid.Parse("70000000-0000-4000-8000-000000000002"))}|{hash}", example);
        // Reviews of every variant move to the survivor; recorded time truncated to milliseconds.
        Assert.Equal(3, await ScalarAsync<long>(t, "SELECT count(*) FROM vocabulary_reviews WHERE word_id = '70000000-0000-4000-8000-000000000002'"));
        var review = await ScalarAsync<string>(t,
            "SELECT concat_ws('|', operation_id, payload_sha256, client_recorded_at, created_at) FROM vocabulary_reviews WHERE id = '72000000-0000-4000-8000-000000000001'");
        var recorded = DateTimeOffset.Parse("2026-02-20T10:00:00.123Z");
        var reviewHash = VocabularyPayloads.ReviewSha256(new VocabularyReview
        {
            WordId = Guid.Parse("70000000-0000-4000-8000-000000000002"),
            ReviewMode = "flashcard",
            IsCorrect = true,
            ResponseTimeMs = 900,
            ClientRecordedAt = recorded,
        });
        Assert.Equal($"{EtlV2Ids.Operation(Guid.Parse("72000000-0000-4000-8000-000000000001"))}|{reviewHash}|2026-02-20 10:00:00.123+00|2026-02-20 10:00:00.123456+00", review);

        // Insights: the catalog review on alice's pair, review_json as stored; the question's legacy hash kept.
        Assert.Equal($"{aliceClean}|meaningful-names|t", await ScalarAsync<string>(t,
            """SELECT concat_ws('|', book_id, chapter_slug, review_json = '{"a":"x","b":[1,2.5]}'::jsonb) FROM book_insight WHERE id = '15000000-0000-4000-8000-000000000001'"""));
        Assert.Equal(Upload, await ScalarAsync<Guid>(t, "SELECT book_id FROM book_insight WHERE id = '15000000-0000-4000-8000-000000000002'"));
        Assert.Equal("deadbeefdeadbeef|1.5", await ScalarAsync<string>(t, "SELECT concat_ws('|', prompt_hash, interval_days) FROM review_question"));

        // Sessions: the pair's has its book; the doomed edition's, the session-only pair's and the deleted upload's have none.
        Assert.Equal(
            $"5e000000-0000-4000-8000-000000000001|{aliceClean}|-|0.1;5e000000-0000-4000-8000-000000000002|-|-|0.2;5e000000-0000-4000-8000-000000000003|-|-|0.01;"
            + $"5e000000-0000-4000-8000-000000000004|-|{DeletedSha}|0.6;5e000000-0000-4000-8000-000000000005|{Upload}|-|0.3",
            await ScalarAsync<string>(t, """
                SELECT string_agg(concat_ws('|', id, coalesce(book_id::text, '-'), coalesce(deleted_book_sha256, '-'), end_percent), ';' ORDER BY id)
                FROM reading_sessions WHERE client_session_id = id
                """));

        // Orphans: reported by id, nothing about them written.
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith($"catalog_pairs {EtlV2Ids.CatalogBook(Carol, CleanCode)}: user"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith($"catalog_pairs {EtlV2Ids.CatalogBook(Bob, Gone)}: edition {Gone} is gone"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("highlights 41000000-0000-4000-8000-000000000002: no book"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("vocabulary_words 70000000-0000-4000-8000-000000000006:"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("vocabulary_reviews 72000000-0000-4000-8000-000000000004:"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("book_insight 15000000-0000-4000-8000-000000000003:"));
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith("reading_sessions 5e000000-0000-4000-8000-000000000006:"));
        Assert.Contains(report.OrphanCandidates, o => o == "reading_sessions 5e000000-0000-4000-8000-000000000003: session-only catalog pair: carried with no book");
        Assert.Empty(report.CleanupActions);
    }

    [Fact]
    public async Task RunAsync_SecondRun_ChangesNothing()
    {
        var options = await NewPairAsync();
        await EtlV2.RunAsync(options, M33, Ct);
        var before = await DumpAsync(options.Target);

        var second = await EtlV2.RunAsync(options, M33, Ct);

        Assert.All(second.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Equal(before, await DumpAsync(options.Target));
    }

    [Fact]
    public async Task RunAsync_DryRun_CountsAndWritesNothing()
    {
        var options = await NewPairAsync(dryRun: true);
        // A dry run on an empty target: M3.2 would have written the users first (here: carol too).
        await ExecAsync(options.Target, "DELETE FROM books; DELETE FROM users");

        var report = await EtlV2.RunAsync(options, M33, Ct);

        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM books) + (SELECT count(*) FROM migration_runs)"));
        Assert.Contains(report.Checks, c => c.Name == "books: would insert 4, unchanged 0");
        Assert.Contains(report.Checks, c => c.Name == "vocabulary_words: would insert 3, unchanged 0");
        Assert.Contains(report.Checks, c => c.Name == "vocabulary_reviews: would insert 4, unchanged 0");
        Assert.Contains(report.Checks, c => c.Name == "reading_sessions: would insert 6, unchanged 0");
        Assert.DoesNotContain(report.Checks, c => c.Name == "sessions.seconds-per-user-equal");
        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
    }

    [Fact]
    public async Task RunAsync_TargetRowDiffers_ReportedNotOverwrittenAndRunFails()
    {
        var options = await NewPairAsync();
        await EtlV2.RunAsync(options, M33, Ct);
        var book = EtlV2Ids.CatalogBook(Alice, CleanCode);
        await ExecAsync(options.Target, "UPDATE books SET title = 'Edited' WHERE id = @book; UPDATE vocabulary_words SET stage = 9", new { book });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, M33, Ct));

        Assert.Contains("validation found", error.Message);
        Assert.Equal("Edited", await ScalarAsync<string>(options.Target, "SELECT title FROM books WHERE id = @book", new { book }));
        var checks = await ScalarAsync<string>(options.Target,
            "SELECT validation->'checks' FROM migration_runs WHERE outcome = 'failed'");
        var failures = JsonSerializer.Deserialize<List<EtlV2Check>>(checks, JsonSerializerOptions.Web)!.Where(c => c.Failures > 0).ToDictionary(c => c.Name, c => c.Failures);
        Assert.Equal(1, failures["books.target-matches-source"]);
        Assert.Equal(1, failures["catalog.intent-pairs-complete"]);
        Assert.Equal(2, failures["vocabulary_words.target-matches-source"]);
        Assert.Equal(2, failures["vocabulary.srs-fields-equal"]);
    }

    [Fact]
    public async Task RunAsync_CardUnderAnotherIdHoldsTheKey_ReportedNotWritten()
    {
        var options = await NewPairAsync();
        var squatter = Guid.NewGuid();
        await ExecAsync(options.Target,
            "INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (@squatter, 'a11ce000-0000-4000-8000-000000000001', 'en', 'RUN', 'run')", new { squatter });

        await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, M33, Ct));

        Assert.Equal(squatter, await ScalarAsync<Guid>(options.Target, "SELECT id FROM vocabulary_words WHERE word_key = 'run'"));
        Assert.Equal(1, await ScalarAsync<int>(options.Target,
            "SELECT (c->>'Failures')::int FROM migration_runs, jsonb_array_elements(validation->'checks') c WHERE c->>'Name' = 'vocabulary_words.key-held-by-another-card'"));
    }

    [Theory]
    [InlineData("UPDATE reading_sessions SET end_percent = 1.5 WHERE id = '5e000000-0000-4000-8000-000000000001'", "reading_sessions.unmappable")]
    [InlineData("UPDATE book_insight SET source = 'app' WHERE id = '15000000-0000-4000-8000-000000000002'", "book_insight.unmappable")]
    [InlineData("UPDATE vocabulary_words SET word = '  ' WHERE id = '70000000-0000-4000-8000-000000000004'", "vocabulary_words.unmappable")]
    public async Task RunAsync_RowTheTargetWouldRefuse_FailsTheRun(string breakSource, string check)
    {
        var options = await NewPairAsync(extra: breakSource + ";");

        await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, M33, Ct));

        Assert.Equal(1, await ScalarAsync<int>(options.Target,
            "SELECT (c->>'Failures')::int FROM migration_runs, jsonb_array_elements(validation->'checks') c WHERE c->>'Name' = @check", new { check }));
    }

    [Fact]
    public async Task RunAsync_TargetRowOfNoSourceUser_FailsUnknownUserCheck()
    {
        var options = await NewPairAsync();
        await ExecAsync(options.Target, """
            INSERT INTO users (id, email, created_at) VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'stray@test', now());
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (gen_random_uuid(), 'eeeeeeee-0000-4000-8000-000000000001', 'en', 'x', 'x');
            """);

        await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(options, M33, Ct));

        Assert.Equal(1, await ScalarAsync<int>(options.Target,
            "SELECT (c->>'Failures')::int FROM migration_runs, jsonb_array_elements(validation->'checks') c WHERE c->>'Name' = 'unknown-user-ids'"));
    }

    [Fact]
    public void Survivor_MostReviewsThenNewestThenLowestId_Deterministic()
    {
        var t = DateTimeOffset.Parse("2026-01-01Z");
        EtlV2Vocabulary.LegacyWord W(string id, int reviews, int day) => new() { Id = Guid.Parse(id), TotalReviews = reviews, UpdatedAt = t.AddDays(day) };

        Assert.Equal(2, Pick(W("00000000-0000-0000-0000-000000000001", 1, 9), W("00000000-0000-0000-0000-000000000002", 2, 0)));
        Assert.Equal(1, Pick(W("00000000-0000-0000-0000-000000000001", 2, 1), W("00000000-0000-0000-0000-000000000002", 2, 0)));
        Assert.Equal(1, Pick(W("00000000-0000-0000-0000-000000000002", 2, 0), W("00000000-0000-0000-0000-000000000001", 2, 0)));

        static int Pick(params EtlV2Vocabulary.LegacyWord[] group) => (int)EtlV2Vocabulary.Survivor(group).Id.ToByteArray(bigEndian: true)[15];
    }

    [Fact]
    public void V5_KnownVector_MatchesRfc()
    {
        // uuid5(NAMESPACE_DNS, "python.org"), the classic check value.
        Assert.Equal(Guid.Parse("886313e1-3b8a-5372-9b90-0c9aee199e5d"),
            EtlV2Ids.V5(Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "python.org"u8.ToArray()));
        Assert.NotEqual(EtlV2Ids.CatalogBook(Alice, CleanCode), EtlV2Ids.CatalogBook(CleanCode, Alice));
    }
}
