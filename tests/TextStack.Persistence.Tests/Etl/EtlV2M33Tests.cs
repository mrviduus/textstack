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
public sealed class EtlV2M33Tests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2), IDisposable
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

    public void Dispose()
    {
        if (Directory.Exists(_files))
            Directory.Delete(_files, recursive: true);
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

    private static Task<EtlV2Exception> FailsAsync(EtlV2Options options) => Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

    /// <summary>The failing ids of the one check named <paramref name="check"/>.</summary>
    private static IReadOnlyList<string>? Failed(EtlV2Exception error, string check) => Assert.Single(error.Checks, c => c.Name == check).Ids;

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
            "reading_sessions: seconds per user differ", "unknown-user-ids: V2 rows whose owner is no legacy user or admin"];
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
    public async Task RunAsync_IntentOnlyInARetiredTable_PairIsCarried(string intent)
    {
        // Owner 2026-11-08 (Q11): lookups, clusters, pending words and shelves still select pairs.
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
    public async Task RunAsync_V2RowOfNoLegacyUser_UnknownUserCheckFails()
    {
        var options = await NewPairAsync(dryRun: true);
        var stray = Guid.Parse("eeeeeeee-0000-4000-8000-000000000001");
        await ExecAsync(options.Target, """
            INSERT INTO users (id, email, created_at) VALUES (@stray, 'stray@test', now());
            INSERT INTO vocabulary_words (id, user_id, language, word, word_key) VALUES (gen_random_uuid(), @stray, 'en', 'x', 'x');
            """, new { stray });

        var error = await FailsAsync(options);

        Assert.Equal([$"vocabulary_words/{stray}"], Failed(error, "unknown-user-ids: V2 rows whose owner is no legacy user or admin"));
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
        { $"UPDATE editions SET title = ' ' WHERE id = '{DesignPatterns}'", "books (catalog): blank edition title", [EtlV2Ids.CatalogBook(Alice, DesignPatterns).ToString()] },
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
        Assert.Equal(EtlV2Ids.CatalogBook(Alice, CleanCode), EtlV2Ids.CatalogBook(Alice, CleanCode));
        Assert.NotEqual(EtlV2Ids.CatalogBook(Alice, CleanCode), EtlV2Ids.CatalogBook(CleanCode, Alice));
    }
}
