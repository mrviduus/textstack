using Application.Vocabulary;
using Domain.Vocabulary;
using Infrastructure.Persistence.Etl;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// M3.3's mappers (catalog pairs, vocabulary, insights, sessions, the unknown-user check), run with M3.2's users
/// and uploads steps before them, on a legacy fixture that mirrors production's shapes: case-variant words, a
/// pair with no progress, a deleted edition, sessions on deleted books and on a session-only pair, a review
/// question with a legacy hash, a dangling shelf entry.
/// </summary>
public sealed class EtlV2M33Tests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2)
{
    private static readonly Guid Alice = Guid.Parse("a11ce000-0000-4000-8000-000000000001");
    private static readonly Guid Bob = Guid.Parse("b0b00000-0000-4000-8000-000000000002");
    private static readonly Guid Carol = Guid.Parse("ca201000-0000-4000-8000-000000000003");
    private static readonly Guid Kobzar = Guid.Parse("bbbbbbbb-0001-0001-0001-000000000002");
    private static readonly Guid CleanCode = Guid.Parse("bbbbbbbb-0003-0003-0003-000000000002");
    private static readonly Guid DesignPatterns = Guid.Parse("bbbbbbbb-0004-0004-0004-000000000002");
    private static readonly Guid Gone = Guid.Parse("dddddddd-0000-4000-8000-000000000002"); // never existed
    private static readonly Guid Upload = Guid.Parse("0b000000-0000-4000-8000-000000000001");
    private static readonly Guid RunSurvivor = Guid.Parse("70000000-0000-4000-8000-000000000002");
    private const string MeaningfulNames = "43b12d1f-7aef-4645-a661-e4bc0239d2c7";
    private const string DeletedSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private const string Site = "11111111-1111-1111-1111-111111111111";

    private const string Fixture = $$"""
        INSERT INTO users (id, email, created_at, is_guest, google_subject) VALUES
            ('a11ce000-0000-4000-8000-000000000001', 'alice@test', '2026-01-01Z', false, NULL),
            ('b0b00000-0000-4000-8000-000000000002', 'bob@test', '2026-01-01Z', true, NULL),
            ('ca201000-0000-4000-8000-000000000003', 'carol@test', '2026-01-01Z', false, NULL);
        INSERT INTO works (id, slug, created_at, site_id) VALUES ('dddddddd-0000-4000-8000-0000000000ff', 'doomed', now(), '{{Site}}');
        INSERT INTO editions (id, work_id, language, slug, title, status, is_public_domain, created_at, updated_at, site_id)
            VALUES ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-0000000000ff', 'en', 'doomed', 'Doomed', 1, true, now(), now(), '{{Site}}');
        INSERT INTO user_books (id, user_id, title, slug, language, status, created_at, updated_at)
            VALUES ('0b000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', 'My Upload', 'my-upload', 'en', 1, '2026-01-02Z', '2026-01-02Z');

        -- Pairs: alice+Clean Code by the library only (no progress); alice+Design Patterns by progress only;
        -- bob+Clean Code by a highlight; carol+Clean Code by the library; bob's shelf names an edition that never existed.
        INSERT INTO user_libraries (id, user_id, edition_id, created_at) VALUES
            (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'bbbbbbbb-0003-0003-0003-000000000002', '2026-02-01Z'),
            (gen_random_uuid(), 'ca201000-0000-4000-8000-000000000003', 'bbbbbbbb-0003-0003-0003-000000000002', '2026-02-01Z'),
            (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '2026-02-01Z');
        INSERT INTO reading_progresses (id, user_id, edition_id, chapter_id, locator, updated_at, site_id)
            VALUES (gen_random_uuid(), 'a11ce000-0000-4000-8000-000000000001', 'bbbbbbbb-0004-0004-0004-000000000002', '{{MeaningfulNames}}', 'x', '2026-02-03Z', '{{Site}}');
        INSERT INTO highlights (id, user_id, site_id, edition_id, anchor_json, color, selected_text, note_text, version, created_at, updated_at) VALUES
            ('41000000-0000-4000-8000-000000000001', 'b0b00000-0000-4000-8000-000000000002', '{{Site}}', 'bbbbbbbb-0003-0003-0003-000000000002', '{}', 'green', 'Clean code reads like prose', 'so true', 3, '2026-02-05Z', '2026-02-06Z'),
            ('41000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'dddddddd-0000-4000-8000-000000000001', '{}', 'yellow', 'lost with its edition', NULL, 1, '2026-02-05Z', '2026-02-05Z');
        INSERT INTO collections (id, user_id, name, sort_order, created_at, updated_at) VALUES ('c0000000-0000-4000-8000-000000000001', 'b0b00000-0000-4000-8000-000000000002', 'Shelf', 0, now(), now());
        INSERT INTO book_collections (collection_id, book_id, book_type, added_at) VALUES ('c0000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002', 'savedbook', now());

        -- Vocabulary: "Run"/"run"/" RUN " (language "EN") collide; the survivor has the most reviews and a translation,
        -- no definition. "Walk"/"walk" tie on reviews: the newer update wins, with no translation of its own.
        INSERT INTO vocabulary_words (id, user_id, site_id, word, language, translation, definition, edition_id, chapter_id, user_book_id, sentence, book_title,
            stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, created_at, updated_at, is_retired, retired_at) VALUES
            ('70000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'Run', 'en', 'бігти', 'to move fast', 'bbbbbbbb-0003-0003-0003-000000000002', '{{MeaningfulNames}}', NULL, 'Run, Forest!', 'Clean Code',
                1, 1, 1, '2026-03-01Z', '2026-02-20Z', 2, 1, '2026-02-10Z', '2026-02-20Z', false, NULL),
            ('70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'run', 'en', 'бігати', NULL, NULL, NULL, '0b000000-0000-4000-8000-000000000001', 'I run daily.', 'My Upload',
                4, 0.3333333333333333, 3, '2026-03-05Z', '2026-02-25Z', 5, 4, '2026-02-11Z', '2026-02-25Z', true, NULL),
            ('70000000-0000-4000-8000-000000000003', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', ' RUN ', 'EN', NULL, 'a lower-ranked loser''s', 'dddddddd-0000-4000-8000-000000000001', NULL, NULL, 'RUN!', 'Doomed',
                0, 0, 0, '2026-03-01Z', NULL, 0, 0, '2026-02-12Z', '2026-02-12Z', false, NULL),
            ('70000000-0000-4000-8000-000000000004', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'Walk', 'en', 'ходити', NULL, NULL, NULL, NULL, NULL, NULL,
                2, 2.5, 2, '2026-03-01Z', NULL, 1, 1, '2026-02-12Z', '2026-02-14Z', false, NULL),
            ('70000000-0000-4000-8000-000000000005', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'walk', 'en', NULL, NULL, NULL, NULL, NULL, '   ', NULL,
                3, 4, 3, '2026-03-02Z', NULL, 1, 1, '2026-02-12Z', '2026-02-15Z', false, NULL),
            ('70000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '{{Site}}', 'carol', 'en', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                0, 0, 0, '2026-03-01Z', NULL, 0, 0, '2026-02-12Z', '2026-02-12Z', false, NULL);
        INSERT INTO vocabulary_reviews (id, vocabulary_word_id, user_id, site_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, created_at) VALUES
            ('72000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'flashcard', true, 900, 0, 1, '2026-02-20 10:00:00.123456Z'),
            ('72000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'multiple_choice', false, 1500, 4, 3, '2026-02-25Z'),
            ('72000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'flashcard', true, 700, 3, 4, '2026-02-26Z'),
            ('72000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '{{Site}}', 'flashcard', true, 700, 0, 1, '2026-02-26Z');

        -- Insights: a chapter review on a catalog pair whose question keeps a legacy hash; one on the upload; carol's.
        INSERT INTO book_insight (id, user_id, site_id, edition_id, user_book_id, chapter_slug, text, question, review_json, created_at, updated_at) VALUES
            ('15000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, 'meaningful-names', 'Names matter', 'Why names?', '{"b": [1, 2.5], "a": "x"}', '2026-02-07Z', '2026-02-08Z'),
            ('15000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', NULL, '0b000000-0000-4000-8000-000000000001', NULL, 'Mine', NULL, NULL, '2026-02-07Z', '2026-02-07Z'),
            ('15000000-0000-4000-8000-000000000003', 'ca201000-0000-4000-8000-000000000003', '{{Site}}', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, NULL, 'Carol''s', NULL, NULL, '2026-02-07Z', '2026-02-07Z');
        INSERT INTO review_question (id, user_id, site_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at) VALUES
            ('16000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', '15000000-0000-4000-8000-000000000001', 0, 'Why?', 'Because.', 'deadbeefdeadbeef', 2, 1.5, 1,
                '2026-03-01Z', '2026-02-09Z', 3, 2, false, '2026-02-07Z', '2026-02-09Z');

        -- Sessions: on a pair; on the doomed edition; bob on a session-only pair; on a deleted upload; on the upload; carol's with no book.
        INSERT INTO reading_sessions (id, user_id, site_id, edition_id, user_book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, deleted_book_sha256, created_at) VALUES
            ('5e000000-0000-4000-8000-000000000001', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'bbbbbbbb-0003-0003-0003-000000000002', NULL, '2026-02-01 10:00Z', '2026-02-01 10:10Z', 600, 2000, 0, 0.1, NULL, '2026-02-01 10:10Z'),
            ('5e000000-0000-4000-8000-000000000002', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', 'dddddddd-0000-4000-8000-000000000001', NULL, '2026-02-02 10:00Z', '2026-02-02 10:05Z', 300, 900, 0.1, 0.2, NULL, '2026-02-02 10:05Z'),
            ('5e000000-0000-4000-8000-000000000003', 'b0b00000-0000-4000-8000-000000000002', '{{Site}}', 'bbbbbbbb-0004-0004-0004-000000000002', NULL, '2026-02-02 10:00Z', '2026-02-02 10:01Z', 60, 100, 0, 0.01, NULL, '2026-02-02 10:01Z'),
            ('5e000000-0000-4000-8000-000000000004', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', NULL, NULL, '2026-02-03 10:00Z', '2026-02-03 10:02Z', 120, 300, 0.5, 0.6, '{{DeletedSha}}', '2026-02-03 10:02Z'),
            ('5e000000-0000-4000-8000-000000000005', 'a11ce000-0000-4000-8000-000000000001', '{{Site}}', NULL, '0b000000-0000-4000-8000-000000000001', '2026-02-04 10:00Z', '2026-02-04 10:03Z', 180, 400, 0, 0.3, NULL, '2026-02-04 10:03Z'),
            ('5e000000-0000-4000-8000-000000000006', 'ca201000-0000-4000-8000-000000000003', '{{Site}}', NULL, NULL, '2026-02-04 10:00Z', '2026-02-04 10:03Z', 180, 400, 0, 0.3, NULL, '2026-02-04 10:03Z');

        -- The doomed edition goes: its library row cascades away, the highlight, word and session keep no edition.
        DELETE FROM editions WHERE id = 'dddddddd-0000-4000-8000-000000000001';
        """;

    private readonly string _files = Path.Combine(Path.GetTempPath(), "etl-v2-m33-tests", Guid.NewGuid().ToString("N"));

    // xunit.v3 calls only DisposeAsync on a class that has both: the temp tree goes here, then the base drops the databases.
    public override async ValueTask DisposeAsync()
    {
        if (Directory.Exists(_files))
            Directory.Delete(_files, recursive: true);
        await base.DisposeAsync();
    }

    private async Task<EtlV2Options> NewPairAsync(bool dryRun = false, string? extra = null)
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        await ExecAsync(source, Fixture + (extra ?? ""));
        var target = await V2.Databases.NewV2Async(name);
        // The upload has no file: the uploads step reads no bytes, but needs both roots.
        Directory.CreateDirectory(Path.Combine(_files, "storage"));
        return new EtlV2Options(source, target, dryRun, StorageRoot: Path.Combine(_files, "storage"), LibraryRoot: Path.Combine(_files, "library"));
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
    public async Task RunAsync_ProductionShapes_CarriesEveryAggregateAndSucceeds()
    {
        var options = await NewPairAsync();

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        string[] named = ["catalog: intent pair incomplete (its book or an annotation is not in V2 as mapped)", "vocabulary_words: parity (SRS fields equal)",
            "vocabulary: review count differs (legacy reviews of a merged group vs its survivor's V2 reviews)", "book_insight: parity", "review_question: parity",
            "reading_sessions: seconds per user differ", "unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users"];
        Assert.All(named, n => Assert.Contains(report.Checks, c => c.Name == n));
        Assert.Equal("succeeded", await ScalarAsync<string>(options.Target, "SELECT outcome FROM migration_runs"));
        var t = options.Target;

        // Books: alice ×2 (library only; progress only), bob ×1 (highlight), carol ×1 (library). Not the gone edition's.
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["books (catalog)"]);
        Assert.Equal(4, await ScalarAsync<long>(t, "SELECT count(*) FROM books WHERE origin->>'kind' = 'catalog'"));
        // uuid v5 ids, deterministic: user ‖ edition.
        var aliceClean = EtlV2Ids.CatalogBook(Alice, CleanCode);
        Assert.Equal("Clean Code|Robert C. Martin|en|clean-code|2026-02-01 00:00:00+00", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', title, author, language, origin->>'editionSlug', created_at) FROM books WHERE id = @id", new { id = aliceClean }));
        Assert.Equal("Erich Gamma", await ScalarAsync<string>(t, "SELECT author FROM books WHERE id = @id", new { id = EtlV2Ids.CatalogBook(Alice, DesignPatterns) }));
        Assert.Equal(0, await ScalarAsync<long>(t, "SELECT count(*) FROM book_files"));
        Assert.Equal(0, await ScalarAsync<long>(t, "SELECT count(*) FROM reading_state"));

        // Bob's highlight: unanchored, on his pair, revision = version. The doomed edition's is M3.2's trail.
        Assert.Equal($"{EtlV2Ids.CatalogBook(Bob, CleanCode)}|green|so true|3|t", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', book_id, color, note_text, revision, locator IS NULL AND file_id IS NULL) FROM annotations"));

        // Vocabulary: "run" (5 reviews) survives the three-way merge, language normalized. Carol's card is carried too.
        Assert.Equal($"{RunSurvivor}|en|run|run|4|0.3333333333333333|3|t", await ScalarAsync<string>(t, """
            SELECT string_agg(concat_ws('|', id, language, word, word_key, stage, interval_days, consecutive_correct, retired_at IS NOT NULL), ';' ORDER BY id)
            FROM vocabulary_words WHERE word_key = 'run'
            """));
        Assert.Equal("70000000-0000-4000-8000-000000000005|walk|4", await ScalarAsync<string>(t,
            "SELECT concat_ws('|', id, word, interval_days) FROM vocabulary_words WHERE word_key = 'walk'"));
        Assert.Equal(3, await ScalarAsync<long>(t, "SELECT count(*) FROM vocabulary_words"));
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
        Assert.Equal($"{EtlV2Ids.Operation(RunSurvivor)}|{hash}", example);
        // Reviews of every variant move to the survivor; recorded time truncated to milliseconds.
        Assert.Equal(3, await ScalarAsync<long>(t, "SELECT count(*) FROM vocabulary_reviews WHERE word_id = @RunSurvivor", new { RunSurvivor }));
        var review = await ScalarAsync<string>(t,
            "SELECT concat_ws('|', operation_id, payload_sha256, client_recorded_at, created_at) FROM vocabulary_reviews WHERE id = '72000000-0000-4000-8000-000000000001'");
        var reviewHash = VocabularyPayloads.ReviewSha256(new VocabularyReview
        {
            WordId = RunSurvivor,
            ReviewMode = "flashcard",
            IsCorrect = true,
            ResponseTimeMs = 900,
            ClientRecordedAt = DateTimeOffset.Parse("2026-02-20T10:00:00.123Z"),
        });
        Assert.Equal($"{EtlV2Ids.Operation(Guid.Parse("72000000-0000-4000-8000-000000000001"))}|{reviewHash}|2026-02-20 10:00:00.123+00|2026-02-20 10:00:00.123456+00", review);

        // Insights: the catalog review on alice's pair, review_json as stored; the question's legacy hash kept; carol's on her pair.
        Assert.Equal($"{aliceClean}|meaningful-names|t", await ScalarAsync<string>(t,
            """SELECT concat_ws('|', book_id, chapter_slug, review_json = '{"a":"x","b":[1,2.5]}'::jsonb) FROM book_insight WHERE id = '15000000-0000-4000-8000-000000000001'"""));
        Assert.Equal(Upload, await ScalarAsync<Guid>(t, "SELECT book_id FROM book_insight WHERE id = '15000000-0000-4000-8000-000000000002'"));
        Assert.Equal(EtlV2Ids.CatalogBook(Carol, CleanCode), await ScalarAsync<Guid>(t, "SELECT book_id FROM book_insight WHERE id = '15000000-0000-4000-8000-000000000003'"));
        Assert.Equal("deadbeefdeadbeef|1.5", await ScalarAsync<string>(t, "SELECT concat_ws('|', prompt_hash, interval_days) FROM review_question"));

        // Orphans: reported by id, nothing about them written.
        Assert.Contains(report.OrphanCandidates, o => o.StartsWith($"catalog_pairs {EtlV2Ids.CatalogBook(Bob, Gone)}: edition {Gone} is gone"));
        Assert.Contains("highlights 41000000-0000-4000-8000-000000000002: no upload and no edition (a deleted upload's trail); not carried", report.OrphanCandidates);
        Assert.Empty(report.CleanupActions);
    }

    [Fact]
    public async Task RunAsync_CaseVariantsMerge_SurvivorTakesALosersFieldOnlyWhereItHasNone()
    {
        // Owner 2026-11-08 (Q8): a loser's translation/definition fills only an empty survivor field, the best-ranked loser's first.
        var options = await NewPairAsync();

        await EtlV2.RunAsync(options, ct: Ct);

        // "run": its own translation kept over the losers'; no definition of its own → the higher-ranked loser's ("Run", 2 reviews), not " RUN "'s.
        Assert.Equal("бігати|to move fast", await ScalarAsync<string>(options.Target, "SELECT concat_ws('|', translation, definition) FROM vocabulary_words WHERE word_key = 'run'"));
        // "walk": no translation of its own → the loser's; neither has a definition → none.
        Assert.Equal("ходити|-", await ScalarAsync<string>(options.Target,
            "SELECT concat_ws('|', translation, coalesce(definition, '-')) FROM vocabulary_words WHERE word_key = 'walk'"));
    }

    [Fact]
    public async Task RunAsync_CatalogPairBook_CarriesTitleAuthorLanguageOnly()
    {
        // Owner 2026-11-08 (Q9): no description, no cover (nor genre, year, tags) on a catalog pair's book; no file.
        var options = await NewPairAsync();

        await EtlV2.RunAsync(options, ct: Ct);

        Assert.True(await ScalarAsync<bool>(options.Target, """
            SELECT bool_and(description IS NULL AND cover_key IS NULL AND genre IS NULL AND published_year IS NULL AND tags = '{}'
                            AND NOT checkpoint_saving_enabled AND removed_at IS NULL AND revision = 1 AND updated_at = created_at)
            FROM books WHERE origin->>'kind' = 'catalog'
            """));
    }

    [Fact]
    public async Task RunAsync_SessionWithNoBook_CarriedWithNullBookAndItsSeconds()
    {
        // Owner 2026-11-08 (Q10): a deleted edition, a session-only pair, a deleted upload: book_id NULL, seconds kept.
        var options = await NewPairAsync();

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(
            $"5e000000-0000-4000-8000-000000000001|{EtlV2Ids.CatalogBook(Alice, CleanCode)}|600|-|0.1;5e000000-0000-4000-8000-000000000002|-|300|-|0.2;"
            + $"5e000000-0000-4000-8000-000000000003|-|60|-|0.01;5e000000-0000-4000-8000-000000000004|-|120|{DeletedSha}|0.6;"
            + $"5e000000-0000-4000-8000-000000000005|{Upload}|180|-|0.3;5e000000-0000-4000-8000-000000000006|-|180|-|0.3",
            await ScalarAsync<string>(options.Target, """
                SELECT string_agg(concat_ws('|', id, coalesce(book_id::text, '-'), duration_seconds, coalesce(deleted_book_sha256, '-'), end_percent), ';' ORDER BY id)
                FROM reading_sessions WHERE client_session_id = id
                """));
        Assert.Contains("reading_sessions 5e000000-0000-4000-8000-000000000003: session-only catalog pair; carried with no book", report.OrphanCandidates);
    }

    /// <summary>One intent row per retired table, each the only intent of bob on The Kobzar.</summary>
    public static TheoryData<string> RetiredIntents => new()
    {
        $"INSERT INTO word_lookups (id, user_id, site_id, word, language, tap_count, edition_id, first_tapped_at, last_tapped_at) VALUES (gen_random_uuid(), '{Bob}', '{Site}', 'kob', 'uk', 1, '{Kobzar}', '2026-02-09Z', now())",
        $"INSERT INTO word_clusters (id, user_id, site_id, title, edition_id, member_count, cohesion_score, is_confirmed, is_dismissed, created_at) VALUES (gen_random_uuid(), '{Bob}', '{Site}', 'c', '{Kobzar}', 1, 0.5, false, false, '2026-02-09Z')",
        $"INSERT INTO pending_vocabulary_words (id, user_id, site_id, word, language, edition_id, priority, source, created_at) VALUES (gen_random_uuid(), '{Bob}', '{Site}', 'kob', 'uk', '{Kobzar}', 1, 'test', '2026-02-09Z')",
        $"INSERT INTO book_collections (collection_id, book_id, book_type, added_at) VALUES ('c0000000-0000-4000-8000-000000000001', '{Kobzar}', 'savedbook', '2026-02-09Z')",
    };

    [Theory]
    [MemberData(nameof(RetiredIntents))]
    [MemberData(nameof(LiveIntents))]
    public async Task RunAsync_IntentInOneTableOnly_PairIsCarried(string intent)
    {
        // Owner 2026-11-08 (Q11): lookups, clusters, pending words and shelves still select pairs, as the live tables do.
        var options = await NewPairAsync(extra: intent + ";");

        await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal("The Kobzar|2026-02-09", await ScalarAsync<string>(options.Target,
            "SELECT title || '|' || (created_at AT TIME ZONE 'UTC')::date FROM books WHERE id = @id", new { id = EtlV2Ids.CatalogBook(Bob, Kobzar) }));
    }

    [Fact]
    public async Task RunAsync_SecondRun_WritesNothingAndChangesNothing()
    {
        var options = await NewPairAsync();
        await EtlV2.RunAsync(options, ct: Ct);
        var before = await DumpAsync(options.Target);

        var second = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(second.Checks, c => Assert.Equal(0, c.Failures));
        Assert.All(second.Writes.Values, w => Assert.Equal(0, w.Inserted + w.Updated));
        Assert.Equal(new EtlV2Writes(0, 0, 4), second.Writes["books (catalog)"]);
        Assert.Equal(before, await DumpAsync(options.Target));
        // The uploads step skips catalog books and their annotations: else every re-run lists each as "V2 row with no legacy row".
        Assert.Empty(second.CleanupActions);
    }

    [Fact]
    public async Task RunAsync_DryRun_CountsWhatWouldBeWrittenAndWritesNothing()
    {
        var options = await NewPairAsync(dryRun: true);

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(0, await ScalarAsync<long>(options.Target, "SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM books) + (SELECT count(*) FROM migration_runs)"));
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["books (catalog)"]);
        Assert.Equal(new EtlV2Writes(1, 0, 0), report.Writes["annotations (catalog)"]);
        Assert.Equal(new EtlV2Writes(3, 0, 0), report.Writes["vocabulary_words"]);
        Assert.Equal(new EtlV2Writes(3, 0, 0), report.Writes["vocabulary_examples"]);
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["vocabulary_reviews"]);
        Assert.Equal(new EtlV2Writes(3, 0, 0), report.Writes["book_insight"]);
        Assert.Equal(new EtlV2Writes(1, 0, 0), report.Writes["review_question"]);
        Assert.Equal(new EtlV2Writes(6, 0, 0), report.Writes["reading_sessions"]);
        Assert.DoesNotContain(report.Checks, c => c.Name.EndsWith(": parity"));
        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
    }

    [Fact]
    public async Task RunAsync_V2RowDiffersFromMapping_MismatchFailsNotOverwritten()
    {
        var options = await NewPairAsync();
        await EtlV2.RunAsync(options, ct: Ct);
        var book = EtlV2Ids.CatalogBook(Alice, CleanCode);
        await ExecAsync(options.Target, "UPDATE books SET title = 'Edited' WHERE id = @book; UPDATE vocabulary_words SET stage = 9 WHERE id = @RunSurvivor", new { book, RunSurvivor });

        var error = await FailsAsync(options);

        Assert.Equal([book.ToString()], Failed(error, "books (catalog): V2 row differs from its legacy mapping"));
        Assert.Equal([RunSurvivor.ToString()], Failed(error, "vocabulary_words: V2 row differs from its legacy mapping"));
        Assert.Equal("Edited|9", await ScalarAsync<string>(options.Target,
            "SELECT (SELECT title FROM books WHERE id = @book) || '|' || (SELECT stage FROM vocabulary_words WHERE id = @RunSurvivor)", new { book, RunSurvivor }));
    }

    [Fact]
    public async Task RunAsync_CardUnderAnotherIdHoldsTheKey_PreflightFailsAndNothingIsWritten()
    {
        var options = await NewPairAsync();
        var squatter = Guid.NewGuid();
        await ExecAsync(options.Target, """
            INSERT INTO users (id, email, created_at) VALUES ('a11ce000-0000-4000-8000-000000000001', 'alice@test', '2026-01-01Z');
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (@squatter, 'a11ce000-0000-4000-8000-000000000001', 'en', 'RUN', 'run');
            """, new { squatter });

        var error = await FailsAsync(options);

        Assert.Equal([$"{RunSurvivor}/{squatter}"], Failed(error, "vocabulary_words: (user_id, language, word_key) held by another V2 id"));
        Assert.Equal(squatter, await ScalarAsync<Guid>(options.Target, "SELECT id FROM vocabulary_words"));
        Assert.Contains(error.CleanupActions, a => a.StartsWith($"vocabulary_words {squatter}: V2 row with no legacy row"));
    }

    [Fact]
    public async Task RunAsync_V2OnlyUserWithABookAndASession_SucceedsAndReportsTheirRows()
    {
        // Owner 2026-11-08: a V2-only user is report-only, and so are its rows (unknown-user and seconds checks pass).
        var options = await NewPairAsync();
        var (stray, book, session) = (Guid.Parse("eeeeeeee-0000-4000-8000-000000000001"), Guid.NewGuid(), Guid.NewGuid());
        await ExecAsync(options.Target, """
            INSERT INTO users (id, email, created_at) VALUES (@stray, 'stray@test', now());
            INSERT INTO books (id, user_id, title, origin) VALUES (@book, @stray, 'Stray', '{"kind":"upload"}');
            INSERT INTO reading_sessions (id, user_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES (@session, @stray, @session, now(), now(), 30, 0, 0, 0, now());
            """, new { stray, book, session });

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Contains($"books {book}: V2 row with no legacy row; not deleted, a human reviews it", report.CleanupActions);
        Assert.Contains($"reading_sessions {session}: V2 row with no legacy row; not deleted, a human reviews it", report.CleanupActions);
        Assert.Contains(report.CleanupActions, a => a.StartsWith($"users {stray}: V2 account with no legacy row"));
    }

    [Fact]
    public async Task RunAsync_V2RowOwnedByAnIdInNeitherDatabase_UnknownUserCheckFails()
    {
        var options = await NewPairAsync(dryRun: true);
        var ghost = Guid.Parse("eeeeeeee-0000-4000-8000-000000000002");
        // V2's FKs forbid this row; replica mode skips them, to stand for a target that drifted from them.
        await ExecAsync(options.Target, """
            SET session_replication_role = replica;
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (gen_random_uuid(), @ghost, 'en', 'x', 'x');
            """, new { ghost });

        var error = await FailsAsync(options);

        Assert.Equal([$"vocabulary_words/{ghost}"], Failed(error, "unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_CatalogChapterSlugBlank_ExampleCarriedUnderTheNumberKey(bool dryRun)
    {
        // B1: legacy's slug is nullable with no CHECK; '' would break V2's chapter_key CHECK. Recoverable: the number fallback.
        var options = await NewPairAsync(dryRun, extra: $"UPDATE chapters SET slug = '  ' WHERE id = '{MeaningfulNames}';");
        var key = "ch-" + await ScalarAsync<int>(options.Source, $"SELECT chapter_number FROM chapters WHERE id = '{MeaningfulNames}'");

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        if (dryRun)
            Assert.Equal(new EtlV2Writes(3, 0, 0), report.Writes["vocabulary_examples"]);
        else
            Assert.Equal(key, await ScalarAsync<string>(options.Target, "SELECT chapter_key FROM vocabulary_examples WHERE sentence = 'Run, Forest!'"));
    }

    /// <summary>
    /// A card's owners and chapter vs its example's book and chapter_key: the legacy edit, the example's sentence,
    /// "book|key" ("-" for none), and the cleanup line the run lists (the chapter is never dropped silently).
    /// </summary>
    public static TheoryData<string, string, string, string> ChapterKeys => new()
    {
        // B2: no owner CHECK in legacy; the upload is the more specific owner. The card's catalog chapter is the edition's, not the upload's.
        { $"UPDATE vocabulary_words SET user_book_id = '{Upload}' WHERE id = '70000000-0000-4000-8000-000000000001'", "Run, Forest!", $"{Upload}|-",
            $"vocabulary_words 70000000-0000-4000-8000-000000000001: both owners set (upload {Upload}, edition {CleanCode}); example kept on the upload, catalog chapter {MeaningfulNames} not carried as its chapter_key" },
        // Legacy ties chapter_id to no edition: a chapter of Clean Code on a Design Patterns card is not that book's chapter.
        { $"UPDATE vocabulary_words SET edition_id = '{DesignPatterns}' WHERE id = '70000000-0000-4000-8000-000000000001'", "Run, Forest!", $"{EtlV2Ids.CatalogBook(Alice, DesignPatterns)}|-",
            $"vocabulary_words 70000000-0000-4000-8000-000000000001: chapter {MeaningfulNames} is not of its edition; example carried with no chapter_key" },
        // An upload-owned card with a catalog chapter.
        { $"UPDATE vocabulary_words SET chapter_id = '{MeaningfulNames}' WHERE id = '{RunSurvivor}'", "I run daily.", $"{Upload}|-",
            $"vocabulary_words {RunSurvivor}: chapter {MeaningfulNames} dropped, the card has no edition; example carried with no chapter_key" },
        // A chapter with no book at all; V2's ck_vocabulary_examples_chapter_key would abort a key without a book.
        { "UPDATE vocabulary_words SET edition_id = NULL WHERE id = '70000000-0000-4000-8000-000000000001'", "Run, Forest!", "-|-",
            $"vocabulary_words 70000000-0000-4000-8000-000000000001: chapter {MeaningfulNames} dropped, the card has no edition; example carried with no chapter_key" },
    };

    [Theory]
    [MemberData(nameof(ChapterKeys))]
    public async Task RunAsync_ChapterNotOfTheExamplesBook_NoChapterKeyAndListed(string sql, string sentence, string bookKey, string line)
    {
        var options = await NewPairAsync(extra: sql + ";");

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(bookKey, await ScalarAsync<string>(options.Target,
            "SELECT coalesce(book_id::text, '-') || '|' || coalesce(chapter_key, '-') FROM vocabulary_examples WHERE sentence = @sentence", new { sentence }));
        Assert.Contains(line, report.CleanupActions);
    }

    [Fact]
    public async Task RunAsync_ProgressOnlyPair_EditionCreatedAtAndConvergesWhenProgressMoves()
    {
        // reading_progresses.updated_at moves between dumps: a pair whose only intent it is takes the edition's created_at.
        var options = await NewPairAsync();
        var pair = EtlV2Ids.CatalogBook(Alice, DesignPatterns);
        var edition = await ScalarAsync<DateTimeOffset>(options.Source, $"SELECT created_at FROM editions WHERE id = '{DesignPatterns}'");
        await EtlV2.RunAsync(options, ct: Ct);

        Assert.True(await ScalarAsync<bool>(options.Target, "SELECT created_at = @edition AND updated_at = @edition FROM books WHERE id = @pair", new { edition, pair }));
        await ExecAsync(options.Source, $"UPDATE reading_progresses SET updated_at = '2026-09-09Z' WHERE edition_id = '{DesignPatterns}'");

        var second = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(second.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Equal(new EtlV2Writes(0, 0, 4), second.Writes["books (catalog)"]);
    }

    [Fact]
    public async Task RunAsync_UploadIdsHeldOnACatalogBook_NamedMismatchNotA23505()
    {
        // A mapped upload row (book, annotation) whose id V2 holds on the catalog side: the uploads step still sees it.
        var (highlight, catalogBook) = (Guid.Parse("41000000-0000-4000-8000-0000000000aa"), Guid.Parse("b0000000-0000-4000-8000-0000000000aa"));
        var options = await NewPairAsync(extra: $$"""
            INSERT INTO highlights (id, user_id, site_id, user_book_id, anchor_json, color, selected_text, version, created_at, updated_at)
            VALUES ('{{highlight}}', '{{Alice}}', '{{Site}}', '{{Upload}}', '{}', 'yellow', 'mine', 1, '2026-02-05Z', '2026-02-05Z');
            """);
        await ExecAsync(options.Target, $$"""
            INSERT INTO users (id, email, created_at) VALUES ('{{Alice}}', 'alice@test', '2026-01-01Z');
            INSERT INTO books (id, user_id, title, origin) VALUES
                ('{{Upload}}', '{{Alice}}', 'My Upload', '{"kind":"catalog","editionSlug":"x"}'),
                ('{{catalogBook}}', '{{Alice}}', 'Other', '{"kind":"catalog","editionSlug":"y"}');
            INSERT INTO annotations (id, user_id, book_id, selected_text) VALUES ('{{highlight}}', '{{Alice}}', '{{catalogBook}}', 'mine');
            """);

        var error = await FailsAsync(options);

        Assert.Equal([Upload.ToString()], Failed(error, "books: V2 row differs from its legacy mapping"));
        Assert.Equal([highlight.ToString()], Failed(error, "annotations: V2 row differs from its legacy mapping"));
        Assert.Null(error.InnerException as Npgsql.PostgresException);
    }

    [Fact]
    public async Task RunAsync_SessionOnARefusedPair_NeitherLinkedNorSessionOnly()
    {
        // The catalog step's pairs are the only ones: a refused pair's session is not "session-only", and links to no book.
        var refusedSession = Guid.Parse("5e000000-0000-4000-8000-000000000007");
        var options = await NewPairAsync(dryRun: true, extra: $"""
            UPDATE editions SET title = ' ' WHERE id = '{DesignPatterns}';
            INSERT INTO reading_sessions (id, user_id, site_id, edition_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES ('{refusedSession}', '{Alice}', '{Site}', '{DesignPatterns}', now(), now(), 10, 0, 0, 0.1, now());
            """);

        var error = await FailsAsync(options);

        Assert.Equal([EtlV2Ids.CatalogBook(Alice, DesignPatterns).ToString()], Failed(error, "books (catalog): blank edition title"));
        Assert.DoesNotContain(error.OrphanCandidates, o => o.Contains(refusedSession.ToString()));
        // Bob has no intent on Design Patterns: his session there is still session-only.
        Assert.Contains("reading_sessions 5e000000-0000-4000-8000-000000000003: session-only catalog pair; carried with no book", error.OrphanCandidates);
    }

    /// <summary>One legacy defect per row: its SQL, the check it must fail, the failing ids.</summary>
    public static TheoryData<string, string, string[]> Defects => new()
    {
        { "UPDATE reading_sessions SET end_percent = 1.5 WHERE id = '5e000000-0000-4000-8000-000000000001'", "reading_sessions: percent outside 0..1", ["5e000000-0000-4000-8000-000000000001"] },
        { "UPDATE reading_sessions SET duration_seconds = -1 WHERE id = '5e000000-0000-4000-8000-000000000001'", "reading_sessions: negative duration or words", ["5e000000-0000-4000-8000-000000000001"] },
        { $"UPDATE reading_sessions SET deleted_book_sha256 = '{DeletedSha.ToUpperInvariant()}' WHERE id = '5e000000-0000-4000-8000-000000000004'",
            "reading_sessions: deleted_book_sha256 is not lowercase hex", ["5e000000-0000-4000-8000-000000000004"] },
        { $"UPDATE reading_sessions SET user_id = '{Bob}' WHERE id = '5e000000-0000-4000-8000-000000000005'", "reading_sessions: its upload belongs to another user", ["5e000000-0000-4000-8000-000000000005"] },
        { "UPDATE book_insight SET source = 'app' WHERE id = '15000000-0000-4000-8000-000000000002'", "book_insight: source V2 does not take (only mcp)", ["15000000-0000-4000-8000-000000000002"] },
        { """UPDATE book_insight SET review_json = '{"a":1}' WHERE id = '15000000-0000-4000-8000-000000000002'""", "book_insight: a review without a chapter", ["15000000-0000-4000-8000-000000000002"] },
        { $"UPDATE review_question SET user_id = '{Bob}'", "review_question: another user's insight", ["16000000-0000-4000-8000-000000000001"] },
        { "UPDATE vocabulary_words SET word = '  ' WHERE id = '70000000-0000-4000-8000-000000000004'", "vocabulary_words: blank word or language", ["70000000-0000-4000-8000-000000000004"] },
        { "UPDATE vocabulary_words SET stage = -1 WHERE id = '70000000-0000-4000-8000-000000000004'", "vocabulary_words: negative SRS field", ["70000000-0000-4000-8000-000000000004"] },
        { $"UPDATE vocabulary_words SET user_book_id = '{Upload}' WHERE id = '70000000-0000-4000-8000-000000000006'", "vocabulary_words: its upload belongs to another user", ["70000000-0000-4000-8000-000000000006"] },
        { "UPDATE vocabulary_reviews SET review_mode = ' ' WHERE id = '72000000-0000-4000-8000-000000000002'", "vocabulary_reviews: blank review_mode", ["72000000-0000-4000-8000-000000000002"] },
        { $"UPDATE vocabulary_reviews SET user_id = '{Carol}' WHERE id = '72000000-0000-4000-8000-000000000002'", "vocabulary_reviews: another user's card", ["72000000-0000-4000-8000-000000000002"] },
        { "UPDATE highlights SET selected_text = ' ' WHERE id = '41000000-0000-4000-8000-000000000001'", "annotations (catalog): blank text or a version below 1", ["41000000-0000-4000-8000-000000000001"] },
        // NaN passes "< 0 or > 1" and Numeric cannot parse it; +Infinity passes "< 0". Named checks, not a crash.
        { "UPDATE reading_sessions SET end_percent = 'NaN' WHERE id = '5e000000-0000-4000-8000-000000000001'", "reading_sessions: percent outside 0..1", ["5e000000-0000-4000-8000-000000000001"] },
        { "UPDATE vocabulary_words SET interval_days = 'Infinity' WHERE id = '70000000-0000-4000-8000-000000000004'", "vocabulary_words: interval_days not a representable number", ["70000000-0000-4000-8000-000000000004"] },
        // Finite but beyond decimal's range: Numeric would overflow.
        { "UPDATE vocabulary_words SET interval_days = 1e300 WHERE id = '70000000-0000-4000-8000-000000000004'", "vocabulary_words: interval_days not a representable number", ["70000000-0000-4000-8000-000000000004"] },
        { $"UPDATE editions SET title = ' ' WHERE id = '{DesignPatterns}'", "books (catalog): blank edition title", [EtlV2Ids.CatalogBook(Alice, DesignPatterns).ToString()] },
        { "UPDATE highlights SET version = 0 WHERE id = '41000000-0000-4000-8000-000000000001'", "annotations (catalog): blank text or a version below 1", ["41000000-0000-4000-8000-000000000001"] },
        { "UPDATE review_question SET interval_days = -1", "review_question: negative SRS field", ["16000000-0000-4000-8000-000000000001"] },
        { $"UPDATE book_insight SET user_id = '{Carol}' WHERE id = '15000000-0000-4000-8000-000000000002'", "book_insight: its upload belongs to another user", ["15000000-0000-4000-8000-000000000002"] },
    };

    [Theory]
    [MemberData(nameof(Defects))]
    public async Task RunAsync_DryRunLegacyDefect_PreflightFailsTheNamedCheck(string sql, string check, string[] ids)
    {
        var options = await NewPairAsync(dryRun: true, extra: sql + ";");

        var error = await FailsAsync(options);

        Assert.Equal(ids, Failed(error, check));
        Assert.Equal(ids.Length, error.Checks.Sum(c => c.Failures));
        Assert.Null(error.RunId);
    }

    [Fact]
    public void Ranked_MostReviewsThenNewestThenLowestId_Deterministic()
    {
        var t = DateTimeOffset.Parse("2026-01-01Z");
        EtlV2Vocabulary.LegacyWord W(string id, int reviews, int day) => new() { Id = Guid.Parse(id), TotalReviews = reviews, UpdatedAt = t.AddDays(day) };

        Assert.Equal(2, Pick(W("00000000-0000-0000-0000-000000000001", 1, 9), W("00000000-0000-0000-0000-000000000002", 2, 0)));
        Assert.Equal(1, Pick(W("00000000-0000-0000-0000-000000000001", 2, 1), W("00000000-0000-0000-0000-000000000002", 2, 0)));
        Assert.Equal(1, Pick(W("00000000-0000-0000-0000-000000000002", 2, 0), W("00000000-0000-0000-0000-000000000001", 2, 0)));

        static int Pick(params EtlV2Vocabulary.LegacyWord[] group) => EtlV2Vocabulary.Ranked(group)[0].Id.ToByteArray(bigEndian: true)[15];
    }

    [Fact]
    public void V5_KnownVector_MatchesRfc()
    {
        // uuid5(NAMESPACE_DNS, "python.org"), the classic check value.
        Assert.Equal(Guid.Parse("886313e1-3b8a-5372-9b90-0c9aee199e5d"),
            EtlV2Ids.V5(Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "python.org"u8.ToArray()));
        Assert.NotEqual(EtlV2Ids.CatalogBook(Alice, CleanCode), EtlV2Ids.CatalogBook(CleanCode, Alice));
    }

    // QA pins (mutation testing, #1028): each kills a mutation the tests above let through.
    private static readonly Guid Dave = Guid.Parse("da7e0000-0000-4000-8000-000000000004");
    private static readonly Guid OpsAdmin = Guid.Parse("0a500000-0000-4000-8000-000000000005");
    private static readonly Guid Squatter = Guid.Parse("eeeeeeee-0000-4000-8000-0000000000aa");
    private static readonly Guid SquatterWord = Guid.Parse("eeeeeeee-0000-4000-8000-0000000000bb");
    private static readonly Guid CarolReview = Guid.Parse("72000000-0000-4000-8000-000000000004");

    [Fact]
    public void Ids_IndependentVectors_PinTheDerivation()
    {
        // Computed outside .NET (RFC 9562 §5.5 with Python's hashlib): the tests above derive ids through EtlV2Ids itself,
        // so a changed namespace, input order or byte order would pass them and still break convergence with any earlier run.
        Assert.Equal(Guid.Parse("1bf10a76-ae74-52e8-9c16-a47a8bfdbae1"), EtlV2Ids.Namespace);
        Assert.Equal(Guid.Parse("a4e4d1c3-613b-5566-884d-a824e9fc9050"), EtlV2Ids.CatalogBook(Alice, CleanCode));
        Assert.Equal(Guid.Parse("f6c8cfa2-7b92-5281-a888-8667e12a9f68"), EtlV2Ids.Operation(RunSurvivor));
    }

    [Fact]
    public async Task RunAsync_CaseVariantsMerge_ExampleHashUsesTheSurvivorsNormalizedKey()
    {
        // " RUN " (language "EN") is a loser: its example hashes under the survivor's (en, run), not its own spelling.
        var options = await NewPairAsync();

        await EtlV2.RunAsync(options, ct: Ct);

        var hash = VocabularyPayloads.ExampleSha256(new VocabularyWord { Language = "en", WordKey = "run" },
            new VocabularyExample { BookTitle = "Doomed", Sentence = "RUN!" });
        Assert.Equal(hash, await ScalarAsync<string>(options.Target, "SELECT payload_sha256 FROM vocabulary_examples WHERE sentence = 'RUN!'"));
    }

    [Fact]
    public async Task RunAsync_SurvivorTranslationBlank_TakesTheLosers()
    {
        // Q8's "has none" is a blank translation too, not only NULL.
        var options = await NewPairAsync(extra: "UPDATE vocabulary_words SET translation = '  ' WHERE id = '70000000-0000-4000-8000-000000000002';");

        await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal("бігти", await ScalarAsync<string>(options.Target, "SELECT translation FROM vocabulary_words WHERE word_key = 'run'"));
    }

    /// <summary>One intent row per live table the fixture never uses as a pair's only intent.</summary>
    public static TheoryData<string> LiveIntents => new()
    {
        $"""
        INSERT INTO vocabulary_words (id, user_id, site_id, word, language, edition_id, stage, interval_days, consecutive_correct, next_review_at,
            total_reviews, correct_reviews, created_at, updated_at, is_retired)
        VALUES (gen_random_uuid(), '{Bob}', '{Site}', 'kob', 'uk', '{Kobzar}', 0, 0, 0, now(), 0, 0, '2026-02-09Z', now(), false)
        """,
        $"INSERT INTO book_insight (id, user_id, site_id, edition_id, text, created_at, updated_at) VALUES (gen_random_uuid(), '{Bob}', '{Site}', '{Kobzar}', 'k', '2026-02-09Z', now())",
    };

    /// <summary>
    /// A V2 row changed after a first run that the re-run must name: legacy setup SQL (or ""), the V2 edit, the check, its failing id.
    /// </summary>
    public static TheoryData<string, string, string, string> Mutations => new()
    {
        // The catalog step reads V2 books by planned id too: a non-catalog row there is a mismatch, not a 23505 on insert.
        { "", $$"""UPDATE books SET origin = '{"kind":"upload"}' WHERE id = '{{EtlV2Ids.CatalogBook(Alice, CleanCode)}}'""",
            "books (catalog): V2 row differs from its legacy mapping", EtlV2Ids.CatalogBook(Alice, CleanCode).ToString() },
        // To Plan that row is a cleanup line and parity checks only mapped rows: the count check alone sees it.
        { "", $"""
            INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, stage_before, stage_after, client_recorded_at)
            VALUES (gen_random_uuid(), '{Alice}', '{RunSurvivor}', gen_random_uuid(), repeat('a', 64), 'flashcard', true, 0, 1, now())
            """, "vocabulary: review count differs (legacy reviews of a merged group vs its survivor's V2 reviews)", RunSurvivor.ToString() },
        // Dave is a legacy user with no session: the per-user sum must cover V2's sessions of a carried user, not only legacy's.
        { $"INSERT INTO users (id, email, created_at, is_guest) VALUES ('{Dave}', 'dave@test', '2026-01-01Z', false)", $"""
            INSERT INTO reading_sessions (id, user_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES ('{Squatter}', '{Dave}', '{Squatter}', now(), now(), 30, 0, 0, 0, now())
            """, "reading_sessions: seconds per user differ", Dave.ToString() },
    };

    [Theory]
    [MemberData(nameof(Mutations))]
    public async Task RunAsync_V2RowChangedAfterARun_ReRunFailsTheNamedCheck(string legacy, string v2, string check, string id)
    {
        var options = await NewPairAsync(extra: legacy == "" ? null : legacy + ";");
        await EtlV2.RunAsync(options, ct: Ct);
        await ExecAsync(options.Target, v2);

        var error = await FailsAsync(options);

        Assert.Equal([id], Failed(error, check));
    }

    /// <summary>A V2 row under another id holding a planned row's secondary key: V2 setup SQL, the check, the failing "row/holder".</summary>
    public static TheoryData<string, string, string> Squatters => new()
    {
        {
            $"""
            INSERT INTO reading_sessions (id, user_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES ('{Squatter}', '{Carol}', '5e000000-0000-4000-8000-000000000006', now(), now(), 0, 0, 0, 0, now())
            """,
            "reading_sessions: (user_id, client_session_id) held by another V2 id", $"5e000000-0000-4000-8000-000000000006/{Squatter}"
        },
        {
            $"""
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES ('{SquatterWord}', '{Carol}', 'en', 'zz', 'zz');
            INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, stage_before, stage_after, client_recorded_at)
            VALUES ('{Squatter}', '{Carol}', '{SquatterWord}', '{EtlV2Ids.Operation(CarolReview)}', repeat('a', 64), 'flashcard', true, 0, 1, now())
            """,
            "vocabulary_reviews: (user_id, operation_id) held by another V2 id", $"{CarolReview}/{Squatter}"
        },
        {
            $"""
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES ('{SquatterWord}', '{Alice}', 'en', 'zz', 'zz');
            INSERT INTO vocabulary_examples (id, user_id, word_id, sentence, operation_id, payload_sha256)
            VALUES ('{Squatter}', '{Alice}', '{SquatterWord}', 'x', '{EtlV2Ids.Operation(RunSurvivor)}', repeat('a', 64))
            """,
            "vocabulary_examples: (user_id, operation_id) held by another V2 id", $"{EtlV2Ids.Operation(RunSurvivor)}/{Squatter}"
        },
        {
            $$"""
            INSERT INTO books (id, user_id, title, origin) VALUES ('{{EtlV2Ids.CatalogBook(Carol, CleanCode)}}', '{{Carol}}', 'x', '{"kind":"catalog"}');
            INSERT INTO book_insight (id, user_id, book_id, text, created_at, updated_at)
            VALUES ('{{Squatter}}', '{{Carol}}', '{{EtlV2Ids.CatalogBook(Carol, CleanCode)}}', 'x', now(), now())
            """,
            "book_insight: (user_id, book_id, chapter_slug) held by another V2 id", $"15000000-0000-4000-8000-000000000003/{Squatter}"
        },
        {
            $$"""
            INSERT INTO books (id, user_id, title, origin) VALUES ('{{EtlV2Ids.CatalogBook(Alice, CleanCode)}}', '{{Alice}}', 'x', '{"kind":"catalog"}');
            INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, created_at, updated_at)
            VALUES ('15000000-0000-4000-8000-000000000001', '{{Alice}}', '{{EtlV2Ids.CatalogBook(Alice, CleanCode)}}', 'meaningful-names', 'x', now(), now());
            INSERT INTO review_question (id, user_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
                next_review_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
            VALUES ('{{Squatter}}', '{{Alice}}', '15000000-0000-4000-8000-000000000001', 0, 'p', 'a', 'deadbeefdeadbeef', 0, 0, 0, now(), 0, 0, false, now(), now())
            """,
            "review_question: (user_id, book_insight_id, prompt_hash) held by another V2 id", $"16000000-0000-4000-8000-000000000001/{Squatter}"
        },
    };

    [Theory]
    [MemberData(nameof(Squatters))]
    public async Task RunAsync_V2RowUnderAnotherIdHoldsAPlannedKey_PreflightFailsTheNamedCheck(string sql, string check, string pair)
    {
        var options = await NewPairAsync(dryRun: true);
        await ExecAsync(options.Target, $"""
            INSERT INTO users (id, email, created_at) VALUES ('{Alice}', 'alice@test', '2026-01-01Z'), ('{Carol}', 'carol@test', '2026-01-01Z');
            {sql};
            """);

        var error = await FailsAsync(options);

        Assert.Equal([pair], Failed(error, check));
    }

    [Fact]
    public async Task UnknownUsers_ChecksEveryOwnedTableAStepWrites()
    {
        // A table a step writes that has a user_id and is not checked would let an unknown owner through unseen.
        var target = await V2.Databases.NewV2Async(NewName());
        var owned = (await ScalarAsync<string>(target,
            "SELECT string_agg(table_name, ',') FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'")).Split(',');

        var written = EtlV2.Steps.SelectMany(s => s.Targets).Intersect(owned);

        // Every written table with a user_id is checked, and every checked table has one (its query reads user_id).
        Assert.Equal(written.Order(StringComparer.Ordinal), EtlV2UnknownUsers.Owned());
    }

    [Fact]
    public async Task RunAsync_V2RowOwnedByALegacyAdmin_UnknownUserCheckPasses()
    {
        // The users step carries admin_users: their V2 rows (made after a run) have a known owner.
        var options = await NewPairAsync(extra: $"""
            INSERT INTO admin_users (id, email, password_hash, role, is_active, created_at, updated_at)
            VALUES ('{OpsAdmin}', 'ops@test', 'hash-ops', 0, true, '2026-01-01Z', '2026-01-01Z');
            """);
        await EtlV2.RunAsync(options, ct: Ct);
        await ExecAsync(options.Target, """
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (@Squatter, @OpsAdmin, 'en', 'ops', 'ops')
            """, new { Squatter, OpsAdmin });

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(0, Assert.Single(report.Checks, c => c.Name == "unknown-user-ids: V2 rows whose owner is in neither legacy nor V2 users").Failures);
    }
}
