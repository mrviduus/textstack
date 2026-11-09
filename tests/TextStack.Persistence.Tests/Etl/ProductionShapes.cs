using System.Text;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// A legacy database shaped like production's, for M3.4's whole-run tests (catalog plan §6, T1–T4) and
/// validate-etl.sql: 30 users (5 guests, mixed-case emails, no case twins), an admin matching a user's email in
/// another case and one with no user; 102 uploads, epub and pdf mixed, a clip, 2 Failed, a takedown, one whose
/// bytes are missing, covers, every progress shape; chapters, anchored/PDF/trail highlights, jobs; catalog pairs
/// from every intent table (retired ones too) plus a dangling shelf entry; vocabulary with case-variant groups and
/// reviews (and .NET-only white space); insights and review questions; sessions on uploads, on a pair, session-only and bookless. Every id and
/// time is fixed, so two databases seeded alike migrate to the same V2 rows.
/// </summary>
internal static class ProductionShapes
{
    public const int Uploads = 102;

    /// <summary>The fb2 upload (ADR-032's pending migration, 0005, has not landed): an extra book, its file Fb2.</summary>
    public const int Fb2Book = 103;

    /// <summary>Taken down (carried hidden), Failed ×2 (carried, listed), bytes missing on disk (no file row).</summary>
    public const int TakenDown = 9, FailedA = 7, FailedB = 8, NoBytes = 10, Clip = 101;

    /// <summary>An anchored highlight ("must flow.") whose chapter text reads "must  flow ." (owner 2026-11-09).</summary>
    public const int QuoteSpaceBeforePeriod = 5;

    /// <summary>
    /// #1150: the anchored highlights of every n % 8 = 5 book are mobile-shaped (no offsets; etl-v2 computes them); book
    /// AnchorQuoteNotFound's also quotes text its chapter lacks (carried without offsets, reported).
    /// </summary>
    public const int AnchorQuoteNotFound = 17;

    /// <summary>#1150: an anchor with legacy mobile's pre-#456 50-character prefix (valid offsets): carried, reported.</summary>
    public const int AnchorLongContext = 25;

    public const int Users = 30, Guests = 5;

    public const string Site = "11111111-1111-1111-1111-111111111111";

    // Seed editions of the legacy baseline.
    public const string Kobzar = "bbbbbbbb-0001-0001-0001-000000000002", ForestSong = "bbbbbbbb-0002-0002-0002-000000000002",
        CleanCode = "bbbbbbbb-0003-0003-0003-000000000002", DesignPatterns = "bbbbbbbb-0004-0004-0004-000000000002";

    public const string MeaningfulNames = "43b12d1f-7aef-4645-a661-e4bc0239d2c7", Introduction = "b6fb37c7-eb08-4b47-bd65-7fe06ad8d6f4";

    /// <summary>A V2 guest the identity mirror left behind: a report-only cleanup line.</summary>
    public static readonly Guid V2OnlyGuest = Guid.Parse("99000000-0000-4000-8000-000000000099");

    public static Guid User(int n) => Id("a0000000", n);

    public static Guid Book(int n) => Id("b0000000", n);

    public static Guid FileOf(int n) => Id("f0000000", n);

    public static int OwnerOf(int book) => 1 + (book - 1) % Users;

    private static Guid Id(string prefix, int n) => Guid.Parse($"{prefix}-0000-4000-8000-{n:D12}");

    // The same ids in SQL, over an expression n.
    private static string Sql(string prefix, string n) => $"format('{prefix}-0000-4000-8000-%s', lpad(({n})::text, 12, '0'))::uuid";

    private static string Format(int n) => n == Clip ? "html" : n == Fb2Book ? "fb2" : n % 2 == 1 ? "epub" : "pdf";

    private static string Dir(int n) => $"users/{User(OwnerOf(n)).ToString()[..2]}/{User(OwnerOf(n))}/books/{Book(n)}";

    public static byte[] Bytes(int n) => Encoding.UTF8.GetBytes($"book-bytes-{n}");

    /// <summary>Every upload's bytes (and covers) under <paramref name="storageRoot"/>, but <see cref="NoBytes"/>'s.</summary>
    public static void WriteFiles(string storageRoot, bool withFb2)
    {
        for (var n = 1; n <= (withFb2 ? Fb2Book : Uploads); n++)
        {
            var dir = Path.Combine(storageRoot, Dir(n));
            Directory.CreateDirectory(dir);
            if (n != NoBytes)
                File.WriteAllBytes(Path.Combine(dir, "book." + Format(n)), Bytes(n));
            if (n % 10 == 1)
                File.WriteAllBytes(Path.Combine(dir, "cover.jpg"), Encoding.UTF8.GetBytes($"cover-{n}"));
        }
    }

    /// <summary>The V2 side before a run: M2.2's shadow row of user 1 (filled by the run, counted as updated) and a V2-only guest.</summary>
    public static string V2Sql => $"""
        INSERT INTO users (id, email, is_guest, created_at) VALUES ('{User(1)}', 'reader1@test.com', false, '2026-11-01Z');
        INSERT INTO users (id, email, is_guest, created_at) VALUES ('{V2OnlyGuest}', 'guest-99@guest.textstack.app', true, '2026-11-01Z');
        """;

    public static string LegacySql(bool withFb2)
    {
        var u = Sql("a0000000", "n");
        var b = Sql("b0000000", "n");
        var owner = Sql("a0000000", "1 + (n - 1) % 30");
        var books = withFb2 ? Fb2Book : Uploads;
        var fmt = $"CASE WHEN n = {Clip} THEN 3 WHEN n = {Fb2Book} THEN 2 WHEN n % 2 = 1 THEN 0 ELSE 1 END";
        var ext = $"CASE WHEN n = {Clip} THEN 'html' WHEN n = {Fb2Book} THEN 'fb2' WHEN n % 2 = 1 THEN 'epub' ELSE 'pdf' END";
        var dir = $"'users/' || left(({owner})::text, 2) || '/' || {owner} || '/books/' || {b}";
        const string T = "'2026-01-01Z'::timestamptz";
        return $$"""
            -- users: 25 accounts (every third email mixed-case, no case twins), 5 guests; subjects null, '' or set; two tiers
            INSERT INTO users (id, email, google_subject, name, is_guest, tier, created_at, last_active_at, storage_used_bytes)
            SELECT {{u}},
                CASE WHEN n > 25 THEN 'guest-' || n || '@guest.textstack.app' WHEN n % 3 = 0 THEN 'Reader' || n || '@Test.com' ELSE 'reader' || n || '@test.com' END,
                CASE WHEN n % 5 = 0 THEN 'g-' || n WHEN n = 4 THEN '' END,
                CASE WHEN n <= 25 THEN 'Reader ' || n END, n > 25,
                CASE WHEN n > 25 THEN 'Guest' WHEN n % 7 = 0 THEN 'Supporter' ELSE 'Free' END,
                {{T}} + n * interval '1 day', {{T}} + n * interval '2 day', n * 1000
            FROM generate_series(1, 30) n;
            -- an active admin matching reader3 in another case (promoted), one with no user (carried as its own row)
            INSERT INTO admin_users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES
                ('ad000000-0000-4000-8000-000000000001', 'READER3@test.com', 'hash-a', 1, true, {{T}}, {{T}}),
                ('ad000000-0000-4000-8000-000000000002', 'ops@test.com', 'hash-ops', 0, true, {{T}}, {{T}});

            -- uploads: odd epub, even pdf, a clip; Failed ×2, a takedown; covers on every tenth; progress in every shape
            INSERT INTO user_books (id, user_id, title, slug, language, status, created_at, updated_at, author, tags, cover_path,
                                    progress_position_json, progress_locator, progress_percent, progress_updated_at, progress_client_updated_at,
                                    is_read, read_at, page_count, is_clip, source_url, takedown_at, takedown_reason, toc_json)
            SELECT {{b}}, {{owner}}, 'Book ' || n, 'book-' || n, CASE WHEN n % 4 = 0 THEN 'uk' ELSE 'en' END,
                CASE WHEN n IN ({{FailedA}}, {{FailedB}}) THEN 2 ELSE 1 END,
                {{T}} + n * interval '1 hour', {{T}} + n * interval '1 hour' + interval '5 minutes',
                CASE WHEN n % 2 = 0 THEN 'Author ' || n END, CASE WHEN n % 3 = 0 THEN '{fiction,classic}'::text[] ELSE '{}' END,
                CASE WHEN n % 10 = 1 THEN {{dir}} || '/cover.jpg' END,
                CASE WHEN n % 2 = 1 AND n % 3 = 0 AND n <> {{Clip}} THEN '{"chapterSlug":"one","chapterFraction":0.5}'::jsonb END,
                CASE WHEN n % 2 = 0 AND n % 4 = 0 THEN 'page:' || n WHEN n % 2 = 1 AND n % 3 <> 0 AND n % 5 = 1 AND n <> {{Clip}} THEN 'scroll:two:100' END,
                CASE WHEN n % 2 = 1 AND n % 3 = 0 THEN 0.25 WHEN n % 4 = 0 THEN 1.0 / 3 END,
                CASE WHEN n % 3 = 0 OR n % 4 = 0 THEN {{T}} + n * interval '1 day' END,
                CASE WHEN n % 6 = 0 THEN {{T}} + n * interval '1 day' - interval '1 minute' END,
                n % 18 = 3, CASE WHEN n % 18 = 3 THEN {{T}} + n * interval '1 day' END,
                CASE WHEN n % 2 = 0 THEN 40 + n END, n = {{Clip}}, CASE WHEN n = {{Clip}} THEN 'https://example.com/clip' END,
                CASE WHEN n = {{TakenDown}} THEN {{T}} + interval '300 days' END, CASE WHEN n = {{TakenDown}} THEN 'dmca' END,
                CASE WHEN n % 7 = 0 THEN '[{"title":"One"}]'::jsonb END
            FROM generate_series(1, {{books}}) n;
            -- one file each; sha256 recorded lower, upper or not at all; book NoBytes's bytes are not on disk
            INSERT INTO user_book_files (id, user_book_id, original_file_name, storage_path, format, sha256, file_size, uploaded_at)
            SELECT {{Sql("f0000000", "n")}}, {{b}}, 'book-' || n || '.' || {{ext}}, {{dir}} || '/book.' || {{ext}}, {{fmt}},
                CASE n % 3 WHEN 0 THEN upper(encode(sha256(convert_to('book-bytes-' || n, 'UTF8')), 'hex'))
                           WHEN 2 THEN encode(sha256(convert_to('book-bytes-' || n, 'UTF8')), 'hex') END,
                length(convert_to('book-bytes-' || n, 'UTF8')), {{T}} + n * interval '1 hour'
            FROM generate_series(1, {{books}}) n;
            -- chapters: epub two (one slug-less → ch-1), pdf one with pages, the clip one
            INSERT INTO user_chapters (id, user_book_id, chapter_number, title, html, plain_text, word_count, slug, source_start_page, source_end_page, created_at)
            SELECT {{Sql("c0000000", "n * 10 + k")}}, {{b}}, k - 1, 'Chapter ' || k,
                '<p>Chapter ' || k || ' of book ' || n || '. The spice must flow.</p><img src="/storage/x.png">',
                'Chapter ' || k || E' of book ' || n || CASE WHEN n = {{QuoteSpaceBeforePeriod}} AND k = 1 THEN E'. The spice\n must  flow .' ELSE E'. The spice\n must  flow.' END, 8,
                CASE WHEN n % 2 = 0 AND n <> {{Clip}} THEN 'p' || k WHEN k = 1 THEN 'one' END,
                CASE WHEN n % 2 = 0 THEN 1 END, CASE WHEN n % 2 = 0 THEN 5 END, {{T}} + n * interval '1 hour' + interval '1 minute'
            FROM generate_series(1, {{books}}) n, generate_series(1, 2) k
            WHERE k = 1 OR (n % 2 = 1 AND n <> {{Clip}});
            -- highlights: anchored on chapter 1 of every fourth epub (whitespace differs from the text; book QuoteSpaceBeforePeriod's
            -- text has a space before its final period, owner 2026-11-09; some offset-less, #1150), PDF ones, a deleted upload's trail
            INSERT INTO highlights (id, user_id, site_id, user_book_id, user_chapter_id, anchor_json, color, selected_text, note_text, version, created_at, updated_at)
            SELECT {{Sql("d0000000", "n")}}, {{owner}}, '{{Site}}'::uuid, {{b}},
                CASE WHEN n % 2 = 1 THEN {{Sql("c0000000", "n * 10 + 1")}} END,
                CASE WHEN n % 2 = 1
                    THEN jsonb_build_object('prefix', CASE WHEN n = {{AnchorLongContext}} THEN repeat('x', 46) || 'The ' ELSE 'The ' END, 'exact', CASE WHEN n = {{AnchorQuoteNotFound}} THEN 'melange' ELSE 'spice must' END, 'suffix', ' flow',
                                            'chapterId', {{Sql("c0000000", "n * 10 + 1")}})
                         || CASE WHEN n % 8 = 5 OR n = {{AnchorQuoteNotFound}} THEN '{}' ELSE '{"startOffset":4,"endOffset":14}' END::jsonb
                    ELSE '{"v":1,"kind":"pdf","page":2,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"torque"}'::jsonb END,
                'yellow', CASE WHEN n = {{QuoteSpaceBeforePeriod}} THEN 'must flow.' WHEN n % 2 = 1 THEN E'spice\tmust' ELSE 'torque' END, CASE WHEN n % 3 = 0 THEN 'note ' || n END, 1 + n % 3,
                {{T}} + n * interval '2 hour', {{T}} + n * interval '3 hour'
            FROM generate_series(1, {{books}}) n WHERE (n % 4 = 1 AND n <> {{Clip}}) OR n % 6 = 0;
            INSERT INTO highlights (id, user_id, site_id, anchor_json, color, selected_text, version, created_at, updated_at, deleted_book_sha256, deleted_chapter_slug)
            SELECT {{Sql("d0000000", "1000 + n")}}, {{Sql("a0000000", "n")}}, '{{Site}}'::uuid, '{"exact":"y"}', 'blue', 'trail ' || n, 1, {{T}}, {{T}}, repeat('a', 64), 'gone'
            FROM generate_series(1, 2) n;
            -- jobs: one per file; the Failed books' failed
            INSERT INTO user_ingestion_jobs (id, user_book_id, user_book_file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at)
            SELECT {{Sql("e0000000", "n")}}, {{b}}, {{Sql("f0000000", "n")}}, CASE WHEN n IN ({{FailedA}}, {{FailedB}}) THEN 3 ELSE 2 END,
                CASE WHEN n IN ({{FailedA}}, {{FailedB}}) THEN 3 ELSE 1 END, CASE WHEN n IN ({{FailedA}}, {{FailedB}}) THEN 'unreadable' END,
                initcap({{ext}}), {{T}} + n * interval '1 hour', {{T}} + n * interval '1 hour' + interval '1 second', {{T}} + n * interval '1 hour' + interval '5 second'
            FROM generate_series(1, {{books}}) n;

            -- catalog pairs, by every intent table: library (Clean Code ×6, Kobzar), progress only (Design Patterns), a catalog
            -- highlight (Forest Song), a card, an insight, and the retired lookups, clusters, pending words, savedbook shelf
            INSERT INTO user_libraries (id, user_id, edition_id, created_at)
            SELECT {{Sql("ab000000", "n")}}, {{u}}, '{{CleanCode}}'::uuid, {{T}} + n * interval '1 day' FROM generate_series(1, 6) n
            UNION ALL SELECT {{Sql("ab000000", "100")}}, {{Sql("a0000000", "2")}}, '{{Kobzar}}'::uuid, {{T}};
            INSERT INTO reading_progresses (id, user_id, edition_id, chapter_id, locator, updated_at, site_id)
            VALUES ({{Sql("ac000000", "1")}}, {{Sql("a0000000", "7")}}, '{{DesignPatterns}}'::uuid, '{{Introduction}}'::uuid, 'x', '2026-02-03Z', '{{Site}}'::uuid);
            INSERT INTO highlights (id, user_id, site_id, edition_id, anchor_json, color, selected_text, note_text, version, created_at, updated_at) VALUES
                ({{Sql("d0000000", "2001")}}, {{Sql("a0000000", "8")}}, '{{Site}}'::uuid, '{{ForestSong}}'::uuid, '{}', 'green', 'Mavka emerges', 'so true', 3, '2026-02-05Z', '2026-02-06Z'),
                ({{Sql("d0000000", "2002")}}, {{Sql("a0000000", "2")}}, '{{Site}}'::uuid, '{{Kobzar}}'::uuid, '{}', 'yellow', 'My thoughts', NULL, 1, '2026-02-05Z', '2026-02-05Z');
            INSERT INTO pending_vocabulary_words (id, user_id, site_id, word, language, edition_id, priority, source, created_at)
            VALUES ({{Sql("ae000000", "1")}}, {{Sql("a0000000", "11")}}, '{{Site}}'::uuid, 'kob', 'uk', '{{Kobzar}}'::uuid, 1, 'test', '2026-02-09Z');
            INSERT INTO word_lookups (id, user_id, site_id, word, language, tap_count, edition_id, first_tapped_at, last_tapped_at)
            VALUES ({{Sql("ae000000", "2")}}, {{Sql("a0000000", "12")}}, '{{Site}}'::uuid, 'mavka', 'uk', 1, '{{ForestSong}}'::uuid, '2026-02-09Z', '2026-03-09Z');
            INSERT INTO word_clusters (id, user_id, site_id, title, edition_id, member_count, cohesion_score, is_confirmed, is_dismissed, created_at)
            VALUES ({{Sql("ae000000", "3")}}, {{Sql("a0000000", "13")}}, '{{Site}}'::uuid, 'c', '{{CleanCode}}'::uuid, 1, 0.5, false, false, '2026-02-09Z');
            INSERT INTO collections (id, user_id, name, sort_order, created_at, updated_at)
            VALUES ({{Sql("af000000", "1")}}, {{Sql("a0000000", "14")}}, 'Shelf', 0, {{T}}, {{T}});
            INSERT INTO book_collections (collection_id, book_id, book_type, added_at) VALUES
                ({{Sql("af000000", "1")}}, '{{DesignPatterns}}'::uuid, 'savedbook', '2026-02-10Z'),
                -- a dangling shelf entry: an edition that never existed (no FK)
                ({{Sql("af000000", "1")}}, 'dddddddd-0000-4000-8000-000000000002'::uuid, 'savedbook', '2026-02-10Z'),
                ({{Sql("af000000", "1")}}, {{Sql("b0000000", "14")}}, 'userbook', '2026-02-10Z');

            -- vocabulary: users 1..20 one card each (every third on its upload); users 5/10/15/20 also "Run"/"run"/" RUN " (EN),
            -- the survivor the most-reviewed; user 9's card on Clean Code's chapter; reviews = total_reviews per card
            INSERT INTO vocabulary_words (id, user_id, site_id, word, language, translation, definition, edition_id, chapter_id, user_book_id, sentence, book_title,
                stage, interval_days, consecutive_correct, next_review_at, last_reviewed_at, total_reviews, correct_reviews, created_at, updated_at, is_retired, retired_at)
            SELECT {{Sql("70000000", "n * 10 + 1")}}, {{u}}, '{{Site}}'::uuid, 'word' || n, 'en', 'tr' || n, NULL, NULL::uuid, NULL::uuid,
                CASE WHEN n % 3 = 0 THEN {{Sql("b0000000", "n")}} END, CASE WHEN n % 2 = 0 THEN 'A sentence with word' || n END,
                CASE WHEN n % 3 = 0 THEN 'Book ' || n END, n % 5, n / 3.0, n % 4, {{T}} + n * interval '1 day', NULL::timestamptz, n % 4, 0,
                {{T}} + n * interval '1 day', {{T}} + n * interval '1 day', n = 4, NULL::timestamptz
            FROM generate_series(1, 20) n
            UNION ALL
            SELECT {{Sql("70000000", "n * 10 + v")}}, {{u}}, '{{Site}}'::uuid, (ARRAY['Run', 'run', ' RUN '])[v - 1], (ARRAY['en', 'en', 'EN'])[v - 1],
                (ARRAY['бігти', NULL, NULL])[v - 1], (ARRAY[NULL, NULL, 'a loser''s'])[v - 1], NULL, NULL, NULL,
                (ARRAY['Run!', 'I run daily.', NULL])[v - 1], NULL, v, 0.3333333333333333 * v, 1, {{T}} + interval '30 days', {{T}} + interval '20 days',
                (ARRAY[2, 5, 0])[v - 1], 1, {{T}} + v * interval '1 day', {{T}} + v * interval '2 day', false, NULL
            FROM generate_series(5, 20, 5) n, generate_series(2, 4) v
            UNION ALL
            SELECT {{Sql("70000000", "95")}}, {{Sql("a0000000", "9")}}, '{{Site}}'::uuid, 'clean', 'en', NULL, NULL, '{{CleanCode}}'::uuid, '{{MeaningfulNames}}'::uuid, NULL,
                'Clean code reads well.', 'Clean Code', 0, 0, 0, {{T}}, NULL, 1, 1, {{T}}, {{T}}, false, NULL
            UNION ALL
            -- .NET white space Postgres \s misses: "Word1" + NBSP in "en" + U+202F is word1's case variant (a loser, no reviews); an NBSP sentence is no example
            SELECT {{Sql("70000000", "16")}}, {{Sql("a0000000", "1")}}, '{{Site}}'::uuid, 'Word1' || chr(160), 'en' || chr(8239), NULL, NULL, NULL, NULL, NULL,
                chr(160), NULL, 0, 0, 0, {{T}}, NULL, 0, 0, {{T}}, {{T}}, false, NULL;
            INSERT INTO vocabulary_reviews (id, vocabulary_word_id, user_id, site_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, created_at)
            SELECT {{Sql("72000000", "substring(w.id::text, 25)::bigint * 10 + i")}}, w.id, w.user_id, '{{Site}}'::uuid, CASE WHEN i % 2 = 0 THEN 'flashcard' ELSE 'multiple_choice' END,
                i % 2 = 0, 500 + i, i - 1, i, {{T}} + i * interval '1 hour' + interval '0.123456 second'
            FROM vocabulary_words w, generate_series(1, w.total_reviews) i;

            -- insights: ten on uploads (reviews need a chapter), one on Forest Song; two with questions keeping a legacy hash
            INSERT INTO book_insight (id, user_id, site_id, edition_id, user_book_id, chapter_slug, text, question, review_json, created_at, updated_at)
            SELECT {{Sql("15000000", "n")}}, {{owner}}, '{{Site}}'::uuid, NULL::uuid, {{b}}, CASE WHEN n % 2 = 0 THEN 'one' END, 'Insight ' || n, 'Why ' || n || '?',
                CASE WHEN n % 4 = 0 THEN '{"b": [1, 2.5], "a": "x"}'::jsonb END, {{T}} + n * interval '1 day', {{T}} + n * interval '2 day'
            FROM generate_series(1, 10) n
            UNION ALL SELECT {{Sql("15000000", "11")}}, {{Sql("a0000000", "10")}}, '{{Site}}'::uuid, '{{ForestSong}}'::uuid, NULL, NULL, 'Mavka', NULL, NULL, {{T}}, {{T}};
            INSERT INTO review_question (id, user_id, site_id, book_insight_id, block_index, prompt, answer, prompt_hash, stage, interval_days, consecutive_correct,
                next_review_at, last_reviewed_at, total_reviews, correct_reviews, is_retired, created_at, updated_at)
            SELECT {{Sql("16000000", "n")}}, {{owner}}, '{{Site}}'::uuid, {{Sql("15000000", "n")}}, 0, 'Prompt ' || n, 'Answer', lpad(n::text, 16, 'f'), 2, 1.0 / 3, 1,
                {{T}} + interval '40 days', NULL, 3, 2, false, {{T}}, {{T}}
            FROM generate_series(4, 8, 4) n;

            -- sessions: on every even upload ≤ 60, on alice's pair, a session-only pair (no intent), a deleted book's, one with no book at all
            INSERT INTO reading_sessions (id, user_id, site_id, edition_id, user_book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, deleted_book_sha256, created_at)
            SELECT {{Sql("5e000000", "n")}}, {{owner}}, '{{Site}}'::uuid, NULL::uuid, {{b}}, {{T}} + n * interval '1 day', {{T}} + n * interval '1 day' + interval '10 minutes',
                60 + n, 100 * n, 0, 0.1 + n / 1000.0, NULL, {{T}} + n * interval '1 day' + interval '10 minutes'
            FROM generate_series(2, 60, 2) n
            UNION ALL SELECT {{Sql("5e000000", "201")}}, {{Sql("a0000000", "1")}}, '{{Site}}'::uuid, '{{CleanCode}}'::uuid, NULL, {{T}}, {{T}}, 600, 2000, 0, 0.1, NULL, {{T}}
            UNION ALL SELECT {{Sql("5e000000", "202")}}, {{Sql("a0000000", "15")}}, '{{Site}}'::uuid, '{{Kobzar}}'::uuid, NULL, {{T}}, {{T}}, 60, 100, 0, 0.01, NULL, {{T}}
            UNION ALL SELECT {{Sql("5e000000", "203")}}, {{Sql("a0000000", "3")}}, '{{Site}}'::uuid, NULL, NULL, {{T}}, {{T}}, 120, 300, 0.5, 0.6, repeat('b', 64), {{T}}
            UNION ALL SELECT {{Sql("5e000000", "204")}}, {{Sql("a0000000", "4")}}, '{{Site}}'::uuid, NULL, NULL, {{T}}, {{T}}, 180, 400, 0, 0.3, NULL, {{T}};
            """;
    }
}
