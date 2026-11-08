using System.Security.Cryptography;
using System.Text;
using Infrastructure.Persistence.Etl;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// M3.2's mappers (users/admin → users; uploads → books, files, state, annotations, chapters) on a legacy
/// database seeded with production's shapes: a mixed-case email matched by an admin, a guest, an M2.2
/// shadow row, an admin with no user, null and recorded sha256s, a missing file, a clip, scroll-only and
/// PDF progress, a slug-less chapter, anchored, PDF and chapterless highlights, a deleted upload's trail.
/// </summary>
public sealed class EtlV2MapperTests(PostgresFixture legacy, V2PostgresFixture v2) : EtlTestBase(legacy, v2), IDisposable
{
    private static readonly Guid Alice = Guid.Parse("a1000000-0000-0000-0000-000000000001");
    private static readonly Guid Bob = Guid.Parse("b2000000-0000-0000-0000-000000000002");
    private static readonly Guid Carol = Guid.Parse("c3000000-0000-0000-0000-000000000003");
    private static readonly Guid OpsAdmin = Guid.Parse("d4000000-0000-0000-0000-000000000004");
    private static readonly Guid AliceAdmin = Guid.Parse("d4000000-0000-0000-0000-000000000005");
    private static readonly Guid Epub = Guid.Parse("e0000000-0000-0000-0000-00000000000e");
    private static readonly Guid EpubFile = Guid.Parse("e0000000-0000-0000-0000-0000000000ef");
    private static readonly Guid Pdf = Guid.Parse("f0000000-0000-0000-0000-00000000000f");
    private static readonly Guid PdfFile = Guid.Parse("f0000000-0000-0000-0000-0000000000ff");
    private static readonly Guid Clip = Guid.Parse("c0000000-0000-0000-0000-00000000000c");
    private static readonly Guid ClipFile = Guid.Parse("c0000000-0000-0000-0000-0000000000cf");
    private static readonly Guid Lost = Guid.Parse("10000000-0000-0000-0000-000000000010");
    private static readonly Guid LostFile = Guid.Parse("10000000-0000-0000-0000-0000000000f0");
    private static readonly Guid Chapter1 = Guid.Parse("11000000-0000-0000-0000-000000000001");
    private static readonly Guid Chapter2 = Guid.Parse("11000000-0000-0000-0000-000000000002");
    private static readonly Guid LostChapter = Guid.Parse("11000000-0000-0000-0000-000000000003");
    private static readonly Guid Anchored = Guid.Parse("12000000-0000-0000-0000-000000000001");
    private static readonly Guid AnchoredNoSlug = Guid.Parse("12000000-0000-0000-0000-000000000002");
    private static readonly Guid PdfHighlight = Guid.Parse("12000000-0000-0000-0000-000000000003");
    private static readonly Guid LostHighlight = Guid.Parse("12000000-0000-0000-0000-000000000004");
    private static readonly Guid Trail = Guid.Parse("12000000-0000-0000-0000-000000000005");
    private static readonly Guid V2OnlyGuest = Guid.Parse("99000000-0000-0000-0000-000000000099");
    private static readonly Guid EpubJob = Guid.Parse("13000000-0000-0000-0000-000000000001");
    private static readonly Guid PdfJob = Guid.Parse("13000000-0000-0000-0000-000000000002");
    private static readonly Guid LostJob = Guid.Parse("13000000-0000-0000-0000-000000000003");

    private static readonly byte[] EpubBytes = Encoding.UTF8.GetBytes("PK epub bytes");
    private static readonly byte[] PdfBytes = Encoding.UTF8.GetBytes("%PDF-1.7 bytes");
    private static readonly byte[] ClipBytes = Encoding.UTF8.GetBytes("<html>clip</html>");
    private static readonly byte[] CoverBytes = [0xFF, 0xD8, 0xFF, 1, 2, 3];

    private readonly string _files = Path.Combine(Path.GetTempPath(), "etl-v2-tests", Guid.NewGuid().ToString("N"));

    private string StorageRoot => Path.Combine(_files, "storage");

    private string LibraryRoot => Path.Combine(_files, "library");

    public void Dispose()
    {
        if (Directory.Exists(_files))
            Directory.Delete(_files, recursive: true);
    }

    private static string Sha(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static string Dir(Guid user, Guid book) => $"users/{user.ToString()[..2]}/{user}/books/{book}";

    private void Put(string relative, byte[] bytes)
    {
        var path = Path.Combine(StorageRoot, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
    }

    private static string FileKey(Guid user, Guid book, Guid file, string format) => $"library/{user.ToString()[..2]}/{user}/{book}/{file}.{format}";

    /// <summary>The scenario: legacy seeded, its bytes on disk, the V2 shadow row and a V2-only guest; the options to run it.</summary>
    private async Task<EtlV2Options> SeedAsync(bool dryRun = false)
    {
        var name = NewName();
        var source = await NewSourceAsync(name);
        var target = await V2.Databases.NewV2Async(name);
        await ExecAsync(source, $$$"""
            INSERT INTO users (id, email, google_subject, name, is_guest, tier, created_at, last_active_at) VALUES
                ('{{{Alice}}}', 'Alice@Test.com', '', 'Alice', false, 'Free', '2025-01-01T10:00:00Z', '2026-10-01T10:00:00Z'),
                ('{{{Bob}}}', 'guest-b2@guest.textstack.app', NULL, 'Guest', true, 'Guest', '2025-02-01T10:00:00Z', '2026-10-02T10:00:00Z'),
                ('{{{Carol}}}', 'carol@test.com', 'google-carol', 'Carol', false, 'Supporter', '2025-03-01T10:00:00Z', NULL);
            INSERT INTO admin_users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES
                ('{{{AliceAdmin}}}', 'alice@test.com', 'hash-a', 1, true, '2025-01-02T10:00:00Z', '2025-01-02T10:00:00Z'),
                ('{{{OpsAdmin}}}', 'ops@test.com', 'hash-ops', 0, true, '2025-01-03T10:00:00Z', '2025-01-03T10:00:00Z');
            INSERT INTO user_books (id, user_id, title, slug, language, status, created_at, updated_at, author, tags, cover_path, toc_json,
                                    progress_position_json, progress_locator, progress_percent, progress_updated_at, progress_client_updated_at,
                                    is_read, read_at, page_count, is_clip, source_url, description, genre, published_year) VALUES
                ('{{{Epub}}}', '{{{Alice}}}', 'Dune', 'dune', 'en', 1, '2025-04-01T10:00:00Z', '2025-04-02T10:00:00Z', 'Herbert', '{scifi,classic}',
                 '{{{Dir(Alice, Epub)}}}/cover.JPG', '[{"title":"One"}]',
                 '{"chapterSlug":"one","chapterFraction":0.5,"anchor":{"prefix":"a","exact":"spice","suffix":"b","startOffset":4,"endOffset":9}}',
                 'scroll:one:120', 0.25, '2025-04-03T10:00:00Z', '2025-04-03T09:59:00Z', true, '2025-04-04T10:00:00Z', NULL, false, NULL,
                 'Desert planet', 'Fiction', 1965),
                ('{{{Pdf}}}', '{{{Alice}}}', 'Manual', 'manual', 'en', 1, '2025-05-01T10:00:00Z', '2025-05-01T10:00:00Z', NULL, '{}', NULL, NULL,
                 NULL, 'page:5', 0.5, '2025-05-02T10:00:00Z', NULL, false, NULL, 40, false, NULL, NULL, NULL, NULL),
                ('{{{Clip}}}', '{{{Bob}}}', 'A web page', 'a-web-page', 'en', 1, '2025-06-01T10:00:00Z', '2025-06-01T10:00:00Z', NULL, '{}', NULL, NULL,
                 NULL, 'scroll:page:340', NULL, '2025-06-02T10:00:00Z', NULL, false, NULL, NULL, true, 'https://example.com/a', NULL, NULL, NULL),
                ('{{{Lost}}}', '{{{Carol}}}', 'Lost', 'lost', 'en', 1, '2025-07-01T10:00:00Z', '2025-07-01T10:00:00Z', NULL, '{}', NULL, NULL,
                 NULL, 'scroll:x:1', 0.1, NULL, NULL, false, NULL, NULL, false, NULL, NULL, NULL, NULL);
            INSERT INTO user_book_files (id, user_book_id, original_file_name, storage_path, format, sha256, file_size, uploaded_at) VALUES
                ('{{{EpubFile}}}', '{{{Epub}}}', 'dune.epub', '{{{Dir(Alice, Epub)}}}/book.epub', 0, NULL, {{{EpubBytes.Length}}}, '2025-04-01T10:00:00Z'),
                ('{{{PdfFile}}}', '{{{Pdf}}}', 'manual.pdf', '{{{Dir(Alice, Pdf)}}}/book.pdf', 1, '{{{Sha(PdfBytes).ToUpperInvariant()}}}', {{{PdfBytes.Length}}}, '2025-05-01T10:00:00Z'),
                ('{{{ClipFile}}}', '{{{Clip}}}', 'clip.html', '{{{Dir(Bob, Clip)}}}/clip.html', 3, '{{{Sha(ClipBytes)}}}', {{{ClipBytes.Length}}}, '2025-06-01T10:00:00Z'),
                ('{{{LostFile}}}', '{{{Lost}}}', 'lost.epub', '{{{Dir(Carol, Lost)}}}/book.epub', 0, NULL, 10, '2025-07-01T10:00:00Z');
            INSERT INTO user_chapters (id, user_book_id, chapter_number, title, html, plain_text, word_count, slug, created_at) VALUES
                ('{{{Chapter1}}}', '{{{Epub}}}', 0, 'One', '<p>The spice must flow.</p>', 'The spice must flow.', 4, 'one', '2025-04-01T10:01:00Z'),
                ('{{{Chapter2}}}', '{{{Epub}}}', 1, 'Two', '<p>Fear is the mind-killer.</p>', 'Fear is the mind-killer.', 4, NULL, '2025-04-01T10:01:00Z'),
                ('{{{LostChapter}}}', '{{{Lost}}}', 1, 'Lost one', '<p>x</p>', 'x', 1, 'x', '2025-07-01T10:01:00Z');
            INSERT INTO highlights (id, user_id, site_id, user_book_id, user_chapter_id, anchor_json, color, selected_text, note_text, version, created_at, updated_at) VALUES
                ('{{{Anchored}}}', '{{{Alice}}}', '11111111-1111-1111-1111-111111111111', '{{{Epub}}}', '{{{Chapter1}}}',
                 '{"prefix":"The ","exact":"spice","suffix":" must","startOffset":4,"endOffset":9,"chapterId":"{{{Chapter1}}}"}', 'yellow', 'spice', 'note', 2,
                 '2025-04-05T10:00:00Z', '2025-04-06T10:00:00Z'),
                ('{{{AnchoredNoSlug}}}', '{{{Alice}}}', '11111111-1111-1111-1111-111111111111', '{{{Epub}}}', '{{{Chapter2}}}',
                 '{"prefix":"","exact":"Fear","suffix":" is","startOffset":0,"endOffset":4}', 'blue', 'Fear', NULL, 1,
                 '2025-04-05T10:00:00Z', '2025-04-05T10:00:00Z'),
                ('{{{PdfHighlight}}}', '{{{Alice}}}', '11111111-1111-1111-1111-111111111111', '{{{Pdf}}}', NULL,
                 '{"v":1,"kind":"pdf","page":3,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"torque"}', 'green', 'torque', NULL, 1,
                 '2025-05-05T10:00:00Z', '2025-05-05T10:00:00Z'),
                ('{{{LostHighlight}}}', '{{{Carol}}}', '11111111-1111-1111-1111-111111111111', '{{{Lost}}}', '{{{LostChapter}}}',
                 '{"prefix":"","exact":"x","suffix":"","startOffset":0,"endOffset":1}', 'yellow', 'x', NULL, 1,
                 '2025-07-05T10:00:00Z', '2025-07-05T10:00:00Z');
            INSERT INTO highlights (id, user_id, site_id, anchor_json, color, selected_text, version, created_at, updated_at, deleted_book_sha256, deleted_chapter_slug) VALUES
                ('{{{Trail}}}', '{{{Carol}}}', '11111111-1111-1111-1111-111111111111', '{"exact":"y"}', 'yellow', 'y', 1,
                 '2025-08-01T10:00:00Z', '2025-08-01T10:00:00Z', '{{{new string('a', 64)}}}', 'gone');
            INSERT INTO user_ingestion_jobs (id, user_book_id, user_book_file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at) VALUES
                ('{{{EpubJob}}}', '{{{Epub}}}', '{{{EpubFile}}}', 2, 1, NULL, 'Epub', '2025-04-01T10:00:00Z', '2025-04-01T10:00:01Z', '2025-04-01T10:00:05Z'),
                ('{{{PdfJob}}}', '{{{Pdf}}}', '{{{PdfFile}}}', 3, 3, 'unreadable', NULL, '2025-05-01T10:00:00Z', NULL, NULL),
                ('{{{LostJob}}}', '{{{Lost}}}', '{{{LostFile}}}', 0, 0, NULL, NULL, '2025-07-01T10:00:00Z', NULL, NULL);
            """);
        Put($"{Dir(Alice, Epub)}/book.epub", EpubBytes);
        Put($"{Dir(Alice, Epub)}/cover.JPG", CoverBytes);
        Put($"{Dir(Alice, Pdf)}/book.pdf", PdfBytes);
        Put($"{Dir(Bob, Clip)}/clip.html", ClipBytes);
        // M2.2's shadow row (id, email, guest flag) and a guest the identity mirror left in V2 only.
        await ExecAsync(target, $"""
            INSERT INTO users (id, email, is_guest, created_at) VALUES ('{Carol}', 'carol@test.com', false, now());
            INSERT INTO users (id, email, is_guest, created_at) VALUES ('{V2OnlyGuest}', 'guest-99@guest.textstack.app', true, now());
            """);
        return new EtlV2Options(source, target, dryRun, StorageRoot: StorageRoot, LibraryRoot: LibraryRoot);
    }

    private Task<T> V2Scalar<T>(EtlV2Options options, string sql, object? args = null) => ScalarAsync<T>(options.Target, sql, args);

    [Fact]
    public async Task RunAsync_ProductionShapes_CarriesEveryAggregateAndSucceeds()
    {
        var options = await SeedAsync();

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
        Assert.Equal("succeeded", await V2Scalar<string>(options, "SELECT outcome FROM migration_runs WHERE id = @id", new { id = report.RunId }));
        // Users: three legacy + the admin with no user; the shadow row filled, not counted as drift; the V2-only guest kept.
        Assert.Equal(new EtlV2Writes(3, 1, 0), report.Writes["users"]);
        Assert.Equal(5, report.TargetCounts["users"]);
        Assert.Equal("admin/Alice@Test.com/", await V2Scalar<string>(options,
            "SELECT role || '/' || email || '/' || COALESCE(google_subject, '') FROM users WHERE id = @Alice", new { Alice }));
        Assert.Equal("reader/Supporter/google-carol/Carol/2025", await V2Scalar<string>(options,
            "SELECT role || '/' || tier || '/' || google_subject || '/' || name || '/' || extract(year FROM created_at) FROM users WHERE id = @Carol", new { Carol }));
        Assert.Equal("admin/hash-ops/false", await V2Scalar<string>(options,
            "SELECT role || '/' || password_hash || '/' || is_guest FROM users WHERE id = @OpsAdmin", new { OpsAdmin }));
        Assert.True(await V2Scalar<bool>(options, "SELECT is_guest AND tier = 'Guest' FROM users WHERE id = @Bob", new { Bob }));
        Assert.Contains(report.CleanupActions, a => a.StartsWith($"users {V2OnlyGuest}: V2 guest with no legacy row") && a.Contains($"DELETE FROM users WHERE id = '{V2OnlyGuest}'"));

        // Books: every upload, the missing file's too; a clip's origin; the cover copied, keyed by the library.
        Assert.Equal(4, report.TargetCounts["books"]);
        TestJson.AssertSameJson("""{"kind":"clip","sourceUrl":"https://example.com/a"}""", await V2Scalar<string>(options, "SELECT origin::text FROM books WHERE id = @Clip", new { Clip }));
        TestJson.AssertSameJson("""{"kind":"upload"}""", await V2Scalar<string>(options, "SELECT origin::text FROM books WHERE id = @Epub", new { Epub }));
        Assert.Equal($"library/a1/{Alice}/{Epub}/cover.jpg|scifi,classic|Fiction|1965", await V2Scalar<string>(options,
            "SELECT cover_key || '|' || array_to_string(tags, ',') || '|' || genre || '|' || published_year FROM books WHERE id = @Epub", new { Epub }));
        Assert.Equal(CoverBytes, await File.ReadAllBytesAsync(Path.Combine(LibraryRoot, $"library/a1/{Alice}/{Epub}/cover.jpg"), Ct));

        // Files: null sha256 hashed from the bytes, a recorded one lowercased; missing bytes = no row; bytes copied, legacy untouched.
        Assert.Equal(3, report.TargetCounts["book_files"]);
        Assert.Equal($"{Sha(EpubBytes)}|epub|{FileKey(Alice, Epub, EpubFile, "epub")}", await V2Scalar<string>(options,
            "SELECT sha256 || '|' || format || '|' || server_storage_key FROM book_files WHERE id = @EpubFile", new { EpubFile }));
        Assert.Equal($"{Sha(PdfBytes)}|pdf|40", await V2Scalar<string>(options, "SELECT sha256 || '|' || format || '|' || page_count FROM book_files WHERE id = @PdfFile", new { PdfFile }));
        Assert.Equal("html", await V2Scalar<string>(options, "SELECT format FROM book_files WHERE id = @ClipFile", new { ClipFile }));
        TestJson.AssertSameJson("""[{"title":"One"}]""", await V2Scalar<string>(options, "SELECT toc::text FROM book_files WHERE id = @EpubFile", new { EpubFile }));
        Assert.Equal(PdfBytes, await File.ReadAllBytesAsync(Path.Combine(LibraryRoot, FileKey(Alice, Pdf, PdfFile, "pdf")), Ct));
        Assert.True(File.Exists(Path.Combine(StorageRoot, $"{Dir(Alice, Pdf)}/book.pdf")));
        Assert.Contains($"user_book_files {LostFile}: no bytes on disk; book {Lost} migrates without a file (ADR-031 item 2)", report.OrphanCandidates);

        // Reading state: a stored position as-is, page:<n> → pdf-page, scroll-only → its chapter, no anchor; is_read → completed_at.
        Assert.Equal(3, report.TargetCounts["reading_state"]);
        TestJson.AssertSameJson("""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"one","chapterFraction":0.5,"anchor":{"prefix":"a","exact":"spice","suffix":"b","startOffset":4,"endOffset":9}}}""",
            await V2Scalar<string>(options, "SELECT current_locator::text FROM reading_state WHERE book_id = @Epub", new { Epub }));
        Assert.Equal("0.25|2025-04-04|2025-04-03 09:59:00", await V2Scalar<string>(options,
            "SELECT book_fraction || '|' || (completed_at AT TIME ZONE 'UTC')::date || '|' || (client_recorded_at AT TIME ZONE 'UTC') FROM reading_state WHERE book_id = @Epub", new { Epub }));
        TestJson.AssertSameJson("""{"version":1,"scheme":"pdf-page","value":{"page":5}}""", await V2Scalar<string>(options, "SELECT current_locator::text FROM reading_state WHERE book_id = @Pdf", new { Pdf }));
        TestJson.AssertSameJson("""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"page","chapterFraction":0}}""",
            await V2Scalar<string>(options, "SELECT current_locator::text FROM reading_state WHERE book_id = @Clip", new { Clip }));
        Assert.Equal(0m, await V2Scalar<decimal>(options, "SELECT book_fraction FROM reading_state WHERE book_id = @Clip", new { Clip }));

        // Chapters: keyed to the book's file; a missing slug → 'ch-' || number; the file-less book's not carried.
        Assert.Equal(2, report.TargetCounts["book_chapters"]);
        Assert.Equal("ch-1|Fear is the mind-killer.", await V2Scalar<string>(options,
            "SELECT chapter_key || '|' || plain_text FROM book_chapters WHERE id = @Chapter2 AND file_id = @EpubFile", new { Chapter2, EpubFile }));
        Assert.Contains($"user_books {Lost}: 1 user_chapters not carried, the book has no file row", report.OrphanCandidates);

        // Annotations: chapterId → chapterKey (fallback too), a PDF anchor as-is, the file-less book's as a quotation; the trail reported.
        Assert.Equal(4, report.TargetCounts["annotations"]);
        TestJson.AssertSameJson("""{"version":1,"scheme":"textstack-anchor-v1","value":{"prefix":"The ","exact":"spice","suffix":" must","startOffset":4,"endOffset":9,"chapterKey":"one"}}""",
            await V2Scalar<string>(options, "SELECT locator::text FROM annotations WHERE id = @Anchored AND file_id = @EpubFile AND revision = 2 AND note_text = 'note'", new { Anchored, EpubFile }));
        Assert.Equal("ch-1", await V2Scalar<string>(options, "SELECT locator -> 'value' ->> 'chapterKey' FROM annotations WHERE id = @AnchoredNoSlug", new { AnchoredNoSlug }));
        Assert.Equal("pdf-page/3", await V2Scalar<string>(options, "SELECT (locator ->> 'scheme') || '/' || (locator -> 'value' ->> 'page') FROM annotations WHERE id = @PdfHighlight", new { PdfHighlight }));
        Assert.True(await V2Scalar<bool>(options, "SELECT locator IS NULL AND file_id IS NULL AND selected_text = 'x' FROM annotations WHERE id = @LostHighlight", new { LostHighlight }));
        Assert.Contains($"highlights {Trail}: no upload and no edition (a deleted upload's trail); not carried", report.OrphanCandidates);
        Assert.Contains(report.Checks, c => c.Name == "annotations: selected_text not in its chapter's plain_text" && c.Failures == 0);
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["library_files"]); // three files and a cover

        // Ingestion jobs: int status → text, source format lowercased, keyed to the carried file; the file-less book's reported.
        Assert.Equal(2, report.TargetCounts["ingestion_jobs"]);
        Assert.Equal("succeeded/epub/1", await V2Scalar<string>(options,
            "SELECT status || '/' || source_format || '/' || attempt_count FROM ingestion_jobs WHERE id = @EpubJob AND file_id = @EpubFile AND user_id = @Alice", new { EpubJob, EpubFile, Alice }));
        Assert.Equal("failed/unreadable", await V2Scalar<string>(options, "SELECT status || '/' || error FROM ingestion_jobs WHERE id = @PdfJob", new { PdfJob }));
        Assert.Contains($"user_ingestion_jobs {LostJob}: not carried, its file {LostFile} has no book_files row", report.OrphanCandidates);
    }

    [Fact]
    public async Task RunAsync_ReRun_ConvergesWithNoWritesAndSameCounts()
    {
        var options = await SeedAsync();
        var first = await EtlV2.RunAsync(options, ct: Ct);

        var second = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(first.SourceCounts, second.SourceCounts);
        Assert.Equal(first.TargetCounts, second.TargetCounts);
        Assert.All(second.Writes.Values, w => Assert.Equal(0, w.Inserted + w.Updated));
        Assert.Equal(new EtlV2Writes(0, 0, 4), second.Writes["users"]);
        Assert.Equal(new EtlV2Writes(0, 0, 4), second.Writes["library_files"]);
        Assert.Equal(first.OrphanCandidates, second.OrphanCandidates);
    }

    [Fact]
    public async Task RunAsync_DryRun_CountsWhatWouldBeWrittenAndWritesNothing()
    {
        var options = await SeedAsync(dryRun: true);

        var report = await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal(new EtlV2Writes(3, 1, 0), report.Writes["users"]);
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["annotations"]);
        Assert.Equal(new EtlV2Writes(4, 0, 0), report.Writes["library_files"]); // three files and a cover
        Assert.Equal(2, report.TargetCounts["users"]);
        Assert.Equal(0, report.TargetCounts["books"]);
        Assert.Equal(0, await V2Scalar<long>(options, "SELECT count(*) FROM migration_runs"));
        Assert.Null(await V2Scalar<string?>(options, "SELECT name FROM users WHERE id = @Carol", new { Carol }));
        Assert.False(Directory.Exists(LibraryRoot));
        Assert.All(report.Checks, c => Assert.Equal(0, c.Failures));
    }

    [Fact]
    public async Task RunAsync_EmailHeldByAnotherV2Id_PreflightFailsAndNothingIsWritten()
    {
        var options = await SeedAsync();
        var holder = Guid.NewGuid();
        await ExecAsync(options.Target, "INSERT INTO users (id, email, created_at) VALUES (@holder, 'alice@test.COM', now())", new { holder });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([$"{Alice}/{holder}"], Assert.Single(error.Checks, c => c.Name == "users: email held by another V2 id").Ids);
        Assert.Equal(1, error.Checks.Sum(c => c.Failures));
        Assert.Equal("failed/ValidationFailed", await V2Scalar<string>(options, "SELECT outcome || '/' || (validation -> 'error' ->> 'type') FROM migration_runs"));
        Assert.Equal(0, await V2Scalar<long>(options, "SELECT count(*) FROM books"));
        Assert.Null(await V2Scalar<string?>(options, "SELECT name FROM users WHERE id = @Carol", new { Carol }));
        Assert.False(Directory.Exists(LibraryRoot));
    }

    [Fact]
    public async Task RunAsync_LegacyEmailsEqualButForCase_DryRunReportsThePair()
    {
        var options = await SeedAsync(dryRun: true);
        var twin = Guid.Parse("a1000000-0000-0000-0000-0000000000a2");
        await ExecAsync(options.Source, "INSERT INTO users (id, email, google_subject, created_at) VALUES (@twin, 'alice@test.com', NULL, now())", new { twin });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([$"{Alice}/{twin}"], Assert.Single(error.Checks, c => c.Name == "users: legacy emails equal but for case").Ids);
        Assert.Null(error.RunId);
    }

    [Fact]
    public async Task RunAsync_ShadowRowAlreadyAdmin_RoleKept()
    {
        var options = await SeedAsync();
        await ExecAsync(options.Target, "UPDATE users SET role = 'admin' WHERE id = @Carol", new { Carol });

        await EtlV2.RunAsync(options, ct: Ct);

        Assert.Equal("admin/Carol", await V2Scalar<string>(options, "SELECT role || '/' || name FROM users WHERE id = @Carol", new { Carol }));
    }

    [Fact]
    public async Task RunAsync_InactiveAdmin_FailsNoRuleDecided()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE admin_users SET is_active = false WHERE id = @OpsAdmin", new { OpsAdmin });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([OpsAdmin.ToString()], Assert.Single(error.Checks, c => c.Failures > 0).Ids);
    }

    [Fact]
    public async Task RunAsync_V2BookDiffersFromMapping_MismatchFailsNotOverwritten()
    {
        var options = await SeedAsync();
        await EtlV2.RunAsync(options, ct: Ct);
        await ExecAsync(options.Target, "UPDATE books SET title = 'Renamed in V2' WHERE id = @Epub", new { Epub });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([Epub.ToString()], Assert.Single(error.Checks, c => c.Name == "books: V2 row differs from its legacy mapping").Ids);
        Assert.Equal("Renamed in V2", await V2Scalar<string>(options, "SELECT title FROM books WHERE id = @Epub", new { Epub }));
    }

    [Fact]
    public async Task RunAsync_V2KeyHoldsOtherBytes_FailsAndKeepsThem()
    {
        var options = await SeedAsync();
        var key = Path.Combine(LibraryRoot, FileKey(Alice, Pdf, PdfFile, "pdf"));
        Directory.CreateDirectory(Path.GetDirectoryName(key)!);
        await File.WriteAllTextAsync(key, "other bytes", Ct);

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([$"user_book_files {PdfFile}"], Assert.Single(error.Checks, c => c.Name == "library_files: V2 key already holds other bytes").Ids);
        Assert.Equal("other bytes", await File.ReadAllTextAsync(key, Ct));
    }

    [Fact]
    public async Task RunAsync_RecordedSha256DiffersFromBytes_Fails()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, $"UPDATE user_book_files SET sha256 = '{new string('0', 64)}' WHERE id = @ClipFile", new { ClipFile });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([$"user_book_files {ClipFile}"], Assert.Single(error.Checks, c => c.Failures > 0).Ids);
    }

    [Fact]
    public async Task RunAsync_Fb2File_FailsUntilV2TakesTheFormat()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE user_book_files SET format = 2 WHERE id = @ClipFile", new { ClipFile });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([ClipFile.ToString()], Assert.Single(error.Checks, c => c.Failures > 0).Ids);
    }

    [Fact]
    public async Task RunAsync_QuoteNotInItsChapter_Fails()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE highlights SET selected_text = 'melange' WHERE id = @Anchored", new { Anchored });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([Anchored.ToString()], Assert.Single(error.Checks, c => c.Name == "annotations: selected_text not in its chapter's plain_text").Ids);
    }

    [Fact]
    public async Task RunAsync_ProgressWithoutLocator_FailsNotGuessed()
    {
        // A "mark as finished" with no position: V2 needs a locator to hold a reading_state row.
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE user_books SET progress_locator = NULL, completed_at = now() WHERE id = @Pdf", new { Pdf });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([Pdf.ToString()], Assert.Single(error.Checks, c => c.Name == "reading_state: legacy progress with no mappable locator").Ids);
    }

    [Fact]
    public async Task RunAsync_HighlightOwnerIsNotTheUploadOwner_Fails()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE highlights SET user_id = @Bob WHERE id = @PdfHighlight", new { Bob, PdfHighlight });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([PdfHighlight.ToString()], Assert.Single(error.Checks, c => c.Name == "annotations: highlight owner is not its upload's owner").Ids);
    }

    [Fact]
    public async Task RunAsync_IngestionJobStatusUnknown_Fails()
    {
        var options = await SeedAsync(dryRun: true);
        await ExecAsync(options.Source, "UPDATE user_ingestion_jobs SET status = 7 WHERE id = @PdfJob", new { PdfJob });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([PdfJob.ToString()], Assert.Single(error.Checks, c => c.Name == "ingestion_jobs: status or source format V2 does not take").Ids);
    }

    [Fact]
    public async Task RunAsync_V2IngestionJobDiffers_MismatchFailsNotOverwritten()
    {
        var options = await SeedAsync();
        await EtlV2.RunAsync(options, ct: Ct);
        await ExecAsync(options.Target, "UPDATE ingestion_jobs SET attempt_count = 9 WHERE id = @EpubJob", new { EpubJob });

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

        Assert.Equal([EpubJob.ToString()], Assert.Single(error.Checks, c => c.Name == "ingestion_jobs: V2 row differs from its legacy mapping").Ids);
        Assert.Equal(9, await V2Scalar<int>(options, "SELECT attempt_count FROM ingestion_jobs WHERE id = @EpubJob", new { EpubJob }));
    }

    [Fact]
    public async Task RunAsync_NoFileRoots_FailsFast()
    {
        var options = await SeedAsync(dryRun: true);

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options with { StorageRoot = null }, ct: Ct));

        Assert.Contains("needs both file roots", error.Message);
    }

    [Fact]
    public async Task RunAsync_LibraryRootInsideStorageRoot_FailsFast()
    {
        var options = await SeedAsync(dryRun: true);

        var error = await Assert.ThrowsAsync<EtlV2Exception>(() =>
            EtlV2.RunAsync(options with { LibraryRoot = Path.Combine(StorageRoot, "library-v2") }, ct: Ct));

        Assert.Contains("are nested", error.Message);
    }
}
