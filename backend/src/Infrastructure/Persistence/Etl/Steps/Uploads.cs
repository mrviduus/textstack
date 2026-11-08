using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Dapper;
using Infrastructure.Services;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// legacy uploads → V2 (ADR-031 rows 33–35 and 43, decided items 1–3, 5, 6): <c>user_books</c> → <c>books</c>,
/// <c>user_book_files</c> → <c>book_files</c> with its bytes copied (never moved: legacy stays the rollback),
/// progress → <c>reading_state</c>, upload highlights → <c>annotations</c>, <c>user_chapters</c> →
/// <c>book_chapters</c> (COPY), <c>user_ingestion_jobs</c> → <c>ingestion_jobs</c>. Ids are legacy's, so a re-run
/// converges. Conflict rule for all six: insert
/// what V2 lacks, leave what is equal, and a V2 row that differs from its mapping is a failed check
/// (never overwritten, never skipped). Books and files first, then what hangs on them, in one fenced transaction.
/// </summary>
public static partial class EtlV2Uploads
{
    public static readonly EtlV2Step Step = new("uploads",
        ["user_books", "user_book_files", "user_chapters", "highlights", "user_ingestion_jobs"],
        ["books", "book_files", "reading_state", "annotations", "book_chapters", "ingestion_jobs"], RunAsync);

    // The resume position, built here so jsonb prints it as the target will (ADR-031 item 5): a stored
    // TextPosition as-is; page:<n> → pdf-page; scroll:<slug>:<px> → its chapter at fraction 0 (px has no
    // chapter length to divide by); anything else is null. Where that is null or unmappable, the chapter slug
    // alone (progress_chapter_slug) at fraction 0, the same scroll-only rule; neither fails "no mappable locator".
    private const string LegacyLocator = """
        CASE
            WHEN jsonb_typeof(b.progress_position_json) = 'object'
                THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1', 'value', b.progress_position_json)
            WHEN b.progress_position_json IS NULL AND b.progress_locator ~ '^page:[1-9][0-9]{0,8}$'
                THEN jsonb_build_object('version', 1, 'scheme', 'pdf-page', 'value', jsonb_build_object('page', substring(b.progress_locator FROM 6)::int))
            WHEN b.progress_position_json IS NULL AND b.progress_locator ~ '^scroll:.+:[^:]*$'
                THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1',
                     'value', jsonb_build_object('chapterSlug', substring(b.progress_locator FROM '^scroll:(.+):[^:]*$'), 'chapterFraction', 0))
        END
        """;

    private const string SelectLegacyBooks = $"""
        SELECT b.id, b.user_id, b.title, b.author, b.language, b.description, b.genre, b.published_year, b.tags, b.cover_path,
               CASE WHEN b.is_clip THEN jsonb_strip_nulls(jsonb_build_object('kind', 'clip', 'sourceUrl', b.source_url))
                    ELSE jsonb_build_object('kind', 'upload') END::text AS origin,
               b.created_at, b.updated_at, b.page_count, b.toc_json::text AS toc,
               (b.progress_locator IS NOT NULL OR b.progress_position_json IS NOT NULL OR b.progress_percent IS NOT NULL
                OR b.completed_at IS NOT NULL OR b.is_read OR NULLIF(b.progress_chapter_slug, '') IS NOT NULL) AS has_progress,
               ({LegacyLocator})::text AS current_locator,
               CASE WHEN NULLIF(b.progress_chapter_slug, '') IS NOT NULL
                   THEN jsonb_build_object('version', 1, 'scheme', 'textstack-position-v1',
                        'value', jsonb_build_object('chapterSlug', b.progress_chapter_slug, 'chapterFraction', 0))
               END::text AS slug_locator,
               b.progress_percent::numeric AS book_fraction,
               COALESCE(b.completed_at, CASE WHEN b.is_read THEN COALESCE(b.read_at, b.updated_at) END) AS completed_at,
               COALESCE(b.progress_client_updated_at, b.progress_updated_at, b.updated_at) AS client_recorded_at,
               COALESCE(b.progress_updated_at, b.updated_at) AS state_updated_at,
               b.takedown_at, b.status
        FROM user_books b
        ORDER BY b.id
        """;

    private const string SelectLegacyFiles = """
        SELECT id, user_book_id AS book_id, original_file_name AS original_name, storage_path, format, lower(sha256) AS sha256,
               file_size AS byte_size, uploaded_at AS created_at
        FROM user_book_files
        ORDER BY id
        """;

    private const string SelectV2Books = """
        SELECT id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin::text AS origin,
               checkpoint_saving_enabled, revision, created_at, updated_at, removed_at
        FROM books
        """;

    private const string SelectV2Files = """
        SELECT id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc::text AS toc, server_storage_key,
               is_current, content_removed_at, created_at
        FROM book_files
        """;

    private const string InsertBook = """
        INSERT INTO books (id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin,
                           checkpoint_saving_enabled, revision, created_at, updated_at, removed_at)
        VALUES (@Id, @UserId, @Title, @Author, @Language, @Description, @Genre, @PublishedYear, @Tags, @CoverKey, CAST(@Origin AS jsonb),
                @CheckpointSavingEnabled, @Revision, @CreatedAt, @UpdatedAt, @RemovedAt)
        """;

    private const string InsertFile = """
        INSERT INTO book_files (id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key,
                                is_current, content_removed_at, created_at)
        VALUES (@Id, @UserId, @BookId, @Sha256, @ByteSize, @OriginalName, @Format, @PageCount, CAST(@Toc AS jsonb), @ServerStorageKey,
                @IsCurrent, @ContentRemovedAt, @CreatedAt)
        """;

    // Legacy BookFormat → book_files.format. Fb2 (2) and Other (99) have no V2 format until ADR-032's migration lands.
    private static readonly Dictionary<int, string> Formats = new() { [0] = "epub", [1] = "pdf", [3] = "html" };

    // Legacy UserBookStatus: Processing = 0, Ready = 1, Failed = 2.
    private static readonly Dictionary<int, string> NotReady = new() { [0] = "Processing", [2] = "Failed" };

    private static readonly Regex CoverExtension = new("^[a-z0-9]{1,5}$", RegexOptions.Compiled);

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var legacyBooks = await EtlV2Rows.SourceAsync<LegacyBook>(context, SelectLegacyBooks, null, ct);
        var legacyFiles = await EtlV2Rows.SourceAsync<LegacyFile>(context, SelectLegacyFiles, null, ct);
        var bytes = new Bytes(context, legacyBooks.Count > 0);

        var books = MapBooks(context, legacyBooks, bytes);
        var byId = legacyBooks.ToDictionary(b => b.Id);
        var files = MapFiles(context, byId, legacyFiles, bytes);
        bytes.Report();
        var states = MapStates(context, legacyBooks, files);
        var annotations = await MapAnnotationsAsync(context, byId, files, ct);
        var takenDown = legacyBooks.Where(b => b.TakedownAt is not null).Select(b => b.Id).ToHashSet();
        var chapters = await MapChaptersAsync(context, files, takenDown, ct);
        var jobs = await MapJobsAsync(context, files, ct);

        var v2Books = await EtlV2Rows.TargetAsync<BookRow>(context, SelectV2Books, null, ct);
        var v2Chapters = await EtlV2Rows.TargetAsync<ChapterRow>(context, SelectV2Chapters, null, ct);
        ReportStaleTakedowns(context, legacyBooks, v2Books, v2Chapters, bytes);
        var bookPlan = Plan(context, "books", books, v2Books, b => b.Id);
        var v2Files = await EtlV2Rows.TargetAsync<FileRow>(context, SelectV2Files, null, ct);
        var filePlan = Plan(context, "book_files", files.Values, v2Files, f => f.Id);
        var statePlan = Plan(context, "reading_state", states, await EtlV2Rows.TargetAsync<StateRow>(context, SelectV2States, null, ct), s => (s.UserId, s.BookId));
        var annotationPlan = Plan(context, "annotations", annotations, await EtlV2Rows.TargetAsync<AnnotationRow>(context, SelectV2Annotations, null, ct), a => a.Id);
        var chapterPlan = Plan(context, "book_chapters", chapters, v2Chapters, c => c.Id);
        // V2's secondary unique keys: a new row whose key a stale V2 row holds (legacy re-extracted, a file replaced) would abort with 23505.
        HeldByAnother(context, "book_files: (user_id, book_id) current file", filePlan.New, v2Files.Where(f => f.IsCurrent), f => f.Id, f => (f.UserId, f.BookId));
        HeldByAnother(context, "book_chapters: (user_id, file_id, chapter_key)", chapterPlan.New, v2Chapters, c => c.Id, c => (c.UserId, c.FileId, c.ChapterKey));
        HeldByAnother(context, "book_chapters: (user_id, book_id, file_id, chapter_number)", chapterPlan.New, v2Chapters, c => c.Id, c => (c.UserId, c.BookId, c.FileId, c.ChapterNumber));
        var jobPlan = Plan(context, "ingestion_jobs", jobs, await EtlV2Rows.TargetAsync<JobRow>(context, SelectV2Jobs, null, ct), j => j.Id);
        context.Writes["library_files"] = new(bytes.Pending.Count, 0, bytes.Present);
        // The gate, on both kinds of run: a failing quote found after the commit would wedge every re-run.
        await CheckQuotesAsync(context, annotations, takenDown, written: false, ct);

        if (!context.MayWrite)
            return;
        await using (var tx = await context.BeginWriteAsync(ct))
        {
            // Inside the fence, so a run that lost it copies nothing; bytes before rows, so a row never names a
            // key with nothing behind it. A run that fails after this leaves bytes no row names (the worker's orphan sweep).
            bytes.CopyPending(ct);
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertBook, bookPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertFile, filePlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertJob, jobPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertState, statePlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertAnnotation, annotationPlan.New, tx.Transaction, cancellationToken: ct));
            await CopyChaptersAsync(context, tx, chapterPlan.New, ct);
            await tx.CommitAsync(ct);
        }

        Verify(context, "books", books, await EtlV2Rows.TargetAsync<BookRow>(context, SelectV2Books, null, ct), b => b.Id, b => b.UserId);
        Verify(context, "book_files", files.Values, await EtlV2Rows.TargetAsync<FileRow>(context, SelectV2Files, null, ct), f => f.Id, f => f.UserId);
        Verify(context, "ingestion_jobs", jobs, await EtlV2Rows.TargetAsync<JobRow>(context, SelectV2Jobs, null, ct), j => j.Id, j => j.UserId);
        Verify(context, "reading_state", states, await EtlV2Rows.TargetAsync<StateRow>(context, SelectV2States, null, ct), s => (s.UserId, s.BookId), s => s.UserId);
        Verify(context, "annotations", annotations, await EtlV2Rows.TargetAsync<AnnotationRow>(context, SelectV2Annotations, null, ct), a => a.Id, a => a.UserId);
        Verify(context, "book_chapters", chapters, await EtlV2Rows.TargetAsync<ChapterRow>(context, SelectV2Chapters, null, ct), c => c.Id, c => c.UserId);
        await CheckQuotesAsync(context, annotations, takenDown, written: true, ct);
    }

    /// <summary>
    /// A takedown since an earlier run: what that run carried (chapters, cover, bytes) is still in V2, and its rows
    /// now differ from the mapping (a failed check). Each named for a human to remove by hand; never deleted by a run.
    /// </summary>
    private static void ReportStaleTakedowns(EtlV2Context context, List<LegacyBook> legacy, List<BookRow> v2Books, List<ChapterRow> v2Chapters, Bytes bytes)
    {
        var chaptersByBook = v2Chapters.ToLookup(c => c.BookId, c => c.Id);
        var covers = v2Books.Where(b => b.CoverKey is not null).ToDictionary(b => b.Id, b => b.CoverKey!);
        foreach (var b in legacy.Where(b => b.TakedownAt is not null))
        {
            const string Stale = "taken down since an earlier run; V2 still holds";
            foreach (var chapter in chaptersByBook[b.Id].Order())
                context.CleanupActions.Add($"books {b.Id}: {Stale} book_chapters {chapter}; a human removes it");
            if (covers.TryGetValue(b.Id, out var cover))
                context.CleanupActions.Add($"books {b.Id}: {Stale} cover_key {cover}; a human clears it");
            foreach (var key in bytes.HeldFor(b.UserId, b.Id))
                context.CleanupActions.Add($"books {b.Id}: {Stale} library bytes {key}; a human removes them");
        }
    }

    /// <summary>The mapped rows against the target; a V2 row that differs from its mapping is a failure, never overwritten.</summary>
    private static EtlV2Plan<T> Plan<T, TKey>(EtlV2Context context, string table, IEnumerable<T> expected, IEnumerable<T> actual, Func<T, TKey> key)
        where TKey : notnull
    {
        var plan = EtlV2Rows.Classify(expected, actual, key);
        EtlV2Rows.Check(context, $"{table}: V2 row differs from its legacy mapping", plan.Different.Select(r => key(r).ToString()!));
        context.Writes[table] = new(plan.New.Count, 0, plan.Unchanged);
        // As users: reported only, never deleted.
        var mapped = expected.Select(key).ToHashSet();
        foreach (var orphan in actual.Select(key).Where(k => !mapped.Contains(k)).Select(k => k.ToString()!).Order(StringComparer.Ordinal))
            context.CleanupActions.Add($"{table} {orphan}: V2 row with no legacy row; not deleted, a human reviews it");
        return plan;
    }

    /// <summary>A new row whose secondary unique key V2 holds under another id: "{key} held by another V2 id", as row/holder.</summary>
    private static void HeldByAnother<T, TKey>(EtlV2Context context, string key, IEnumerable<T> rows, IEnumerable<T> v2, Func<T, Guid> id, Func<T, TKey> value)
        where TKey : notnull
    {
        var holders = v2.ToLookup(value, id);
        EtlV2Rows.Check(context, $"{key} held by another V2 id",
            rows.SelectMany(r => holders[value(r)].Where(holder => holder != id(r)).Select(holder => $"{id(r)}/{holder}")));
    }

    /// <summary>After the write: every mapped row is in V2 as mapped (count and content parity), and under its legacy owner.</summary>
    private static void Verify<T, TKey>(EtlV2Context context, string table, IEnumerable<T> expected, List<T> actual, Func<T, TKey> key, Func<T, Guid> owner)
        where TKey : notnull
    {
        var after = EtlV2Rows.Classify(expected, actual, key);
        EtlV2Rows.Check(context, $"{table}: parity", after.New.Concat(after.Different).Select(r => key(r).ToString()!));
        var owners = actual.ToDictionary(key, owner);
        EtlV2Rows.Check(context, $"{table}: ownership", expected.Where(r => owners.TryGetValue(key(r), out var o) && o != owner(r)).Select(r => key(r).ToString()!));
    }

    private static List<BookRow> MapBooks(EtlV2Context context, List<LegacyBook> legacy, Bytes bytes)
    {
        var blank = new List<string>();
        var rows = new List<BookRow>();
        foreach (var b in legacy)
        {
            if (string.IsNullOrWhiteSpace(b.Title))
                blank.Add(b.Id.ToString());
            // Owner 2026-11-08: a takedown is carried hidden (removed_at) with no bytes and no chapters; legacy keeps the bytes.
            if (b.TakedownAt is not null)
                context.OrphanCandidates.Add($"user_books {b.Id}: taken down; carried hidden (removed_at, file content_removed_at) without bytes, cover or chapters");
            // Owner 2026-11-08: a Processing or Failed upload is still the user's file: carried as is, listed for a human.
            if (NotReady.TryGetValue(b.Status, out var status))
                context.CleanupActions.Add($"user_books {b.Id}: legacy status {status}, carried with its bytes; a human reviews it");
            rows.Add(new BookRow
            {
                Id = b.Id,
                UserId = b.UserId,
                Title = b.Title,
                Author = b.Author,
                Language = b.Language,
                Description = b.Description,
                Genre = b.Genre,
                PublishedYear = b.PublishedYear,
                Tags = b.Tags,
                Origin = b.Origin,
                CreatedAt = b.CreatedAt,
                UpdatedAt = b.UpdatedAt,
                CoverKey = b.CoverPath is null || b.TakedownAt is not null ? null : Cover(context, b, bytes),
                RemovedAt = b.TakedownAt,
            });
        }
        EtlV2Rows.Check(context, "books: blank title", blank);
        return rows;
    }

    // The cover's V2 key, its bytes queued; null (reported) when legacy has no bytes for it.
    private static string? Cover(EtlV2Context context, LegacyBook b, Bytes bytes)
    {
        var extension = Path.GetExtension(b.CoverPath)!.TrimStart('.').ToLowerInvariant();
        if (CoverExtension.IsMatch(extension) && bytes.Store.CoverKey(b.UserId, b.Id, extension) is var key
            && bytes.Carry($"user_books {b.Id} cover", b.CoverPath!, key, null) is not null)
            return key;
        context.OrphanCandidates.Add($"user_books {b.Id}: cover not carried (missing on disk or no image extension); cover_key left null");
        return null;
    }

    private static Dictionary<Guid, FileRow> MapFiles(EtlV2Context context, Dictionary<Guid, LegacyBook> books, List<LegacyFile> legacy, Bytes bytes)
    {
        var several = legacy.GroupBy(f => f.BookId).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
        // No rule says which of several is current: refused, never guessed.
        EtlV2Rows.Check(context, "book_files: more than one legacy file for a book", several.Select(id => id.ToString()));
        EtlV2Rows.Check(context, "book_files: format V2 does not take (fb2/other, pending ADR-032's migration)",
            legacy.Where(f => !Formats.ContainsKey(f.Format)).Select(f => f.Id.ToString()));
        EtlV2Rows.Check(context, "book_files: not a positive byte size or a blank name",
            legacy.Where(f => f.ByteSize <= 0 || string.IsNullOrWhiteSpace(f.OriginalName)).Select(f => f.Id.ToString()));
        var rows = new Dictionary<Guid, FileRow>();
        foreach (var f in legacy.Where(f => !several.Contains(f.BookId) && Formats.ContainsKey(f.Format)))
        {
            var book = books[f.BookId];
            var format = Formats[f.Format];
            var key = bytes.Store.FileKey(book.UserId, book.Id, f.Id, format);
            var takenDown = book.TakedownAt is not null;
            // ADR-031 item 2: null sha256 → hashed from the bytes; no bytes → no row, the book stays without a file.
            // A takedown's bytes are hashed, never copied.
            if (bytes.Carry($"user_book_files {f.Id}", f.StoragePath, key, f.Sha256, copy: !takenDown, recordedSize: f.ByteSize) is not (string sha256, long length))
            {
                context.OrphanCandidates.Add($"user_book_files {f.Id}: no bytes on disk; book {book.Id} migrates without a file (ADR-031 item 2)");
                continue;
            }
            if (f.Sha256 == sha256 && f.ByteSize != length)
                context.CleanupActions.Add($"book_files {f.Id}: legacy file_size {f.ByteSize} differs from the bytes ({length}); byte_size taken from the bytes");
            rows[book.Id] = new FileRow
            {
                Id = f.Id,
                UserId = book.UserId,
                BookId = book.Id,
                Sha256 = sha256,
                // The bytes are the truth (V2's quota sums byte_size); a recorded sha256 has vouched for them.
                ByteSize = length,
                OriginalName = f.OriginalName,
                Format = format,
                PageCount = book.PageCount,
                Toc = book.Toc,
                ServerStorageKey = takenDown ? null : key,
                ContentRemovedAt = book.TakedownAt,
                CreatedAt = f.CreatedAt,
            };
        }
        return rows;
    }

    /// <summary>
    /// Legacy bytes and their V2 keys: read from <c>Storage:RootPath</c>, copied under <c>Storage:LibraryRoot</c> on a
    /// real run only, never over different bytes, never deleted or moved at the source.
    /// </summary>
    private sealed class Bytes
    {
        private readonly EtlV2Context _context;
        private readonly string _storageRoot = "";
        private readonly string _libraryRoot = "";
        private readonly LibraryFileStore? _store;
        private readonly List<string> _outside = [];
        private readonly List<string> _wrongHash = [];
        private readonly List<string> _keyTaken = [];
        private readonly List<string> _wrongSize = [];

        public Bytes(EtlV2Context context, bool needed)
        {
            _context = context;
            if (!needed)
                return;
            if (string.IsNullOrWhiteSpace(context.StorageRoot) || string.IsNullOrWhiteSpace(context.LibraryRoot))
                throw new InvalidOperationException("carrying uploads needs both file roots (Storage:RootPath, Storage:LibraryRoot)");
            // An unmounted root would read as "every file missing": a run that carries no bytes and succeeds.
            if (!Directory.Exists(context.StorageRoot))
                throw new InvalidOperationException("Storage:RootPath does not exist; is legacy's storage mounted?");
            _storageRoot = FileStoreRegistration.AsDirectory(context.StorageRoot);
            _libraryRoot = Path.GetFullPath(context.LibraryRoot);
            // /storage is served publicly: copied library bytes under it would be too (#1110).
            if (FileStoreRegistration.RootsAreNested(context.StorageRoot, context.LibraryRoot))
                throw new InvalidOperationException("Storage:LibraryRoot and Storage:RootPath are nested; make them separate directories (#1110)");
            _store = new LibraryFileStore(_libraryRoot);
        }

        /// <summary>The checks over every <see cref="Carry"/> so far.</summary>
        public void Report()
        {
            EtlV2Rows.Check(_context, "library_files: legacy path outside Storage:RootPath", _outside);
            EtlV2Rows.Check(_context, "library_files: bytes differ from the recorded sha256", _wrongHash);
            EtlV2Rows.Check(_context, "library_files: V2 key already holds other bytes", _keyTaken);
            EtlV2Rows.Check(_context, "library_files: bytes differ from the recorded file_size (no recorded sha256)", _wrongSize);
        }

        /// <summary>The library's keys; only when there are uploads to carry (the roots were checked).</summary>
        public LibraryFileStore Store => _store ?? throw new InvalidOperationException("no uploads to carry: the library store is not configured");

        /// <summary>The keys of the files the library holds under a book's directory.</summary>
        public IEnumerable<string> HeldFor(Guid userId, Guid bookId)
        {
            var dir = Path.Combine(_libraryRoot, Path.GetDirectoryName(Store.CoverKey(userId, bookId, "x"))!);
            return Directory.Exists(dir)
                ? Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Select(f => Path.GetRelativePath(_libraryRoot, f)).Order(StringComparer.Ordinal)
                : [];
        }

        public List<(string From, string To)> Pending { get; } = [];

        public int Present { get; private set; }

        /// <summary>The bytes' SHA-256 and length when legacy has them (copy queued, unless V2 holds them already or not <paramref name="copy"/>); null when missing.</summary>
        public (string Sha256, long Length)? Carry(string what, string relativePath, string key, string? recordedSha256, bool copy = true, long? recordedSize = null)
        {
            var from = Path.GetFullPath(Path.Combine(_storageRoot, relativePath));
            if (!from.StartsWith(_storageRoot, StringComparison.Ordinal))
            {
                _outside.Add(what);
                return null;
            }
            if (!File.Exists(from))
                return null;
            var sha256 = Hash(from);
            var length = new FileInfo(from).Length;
            if (recordedSha256 is not null && recordedSha256 != sha256)
                _wrongHash.Add(what);
            // No recorded hash to vouch for them: byte_size is legacy's file_size, so it must be the bytes' length.
            if (recordedSha256 is null && recordedSize is { } size && size != length)
                _wrongSize.Add(what);
            if (!copy)
                return (sha256, length);
            var to = Path.Combine(_libraryRoot, key);
            if (!File.Exists(to))
                Pending.Add((from, to));
            // Another length is other bytes, no hash needed; an equal one is confirmed by hash.
            else if (new FileInfo(to).Length == length && Hash(to) == sha256)
                Present++;
            else
                _keyTaken.Add(what);
            return (sha256, length);
        }

        /// <summary>Each queued copy to a temp file beside its key, then renamed into place; an existing key is never overwritten.</summary>
        public void CopyPending(CancellationToken ct)
        {
            foreach (var (from, to) in Pending)
            {
                ct.ThrowIfCancellationRequested();
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                var temp = $"{to}.{Guid.NewGuid():N}.tmp";
                try
                {
                    File.Copy(from, temp);
                    File.Move(temp, to, overwrite: false);
                }
                finally
                {
                    File.Delete(temp);
                }
            }
        }

        private static string Hash(string path)
        {
            using var stream = File.OpenRead(path);
            return Convert.ToHexStringLower(SHA256.HashData(stream));
        }
    }

    private sealed record LegacyBook
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Title { get; init; } = "";
        public string? Author { get; init; }
        public string? Language { get; init; }
        public string? Description { get; init; }
        public string? Genre { get; init; }
        public int? PublishedYear { get; init; }
        public string[] Tags { get; init; } = [];
        public string? CoverPath { get; init; }
        public string Origin { get; init; } = "";
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public int? PageCount { get; init; }
        public string? Toc { get; init; }
        public bool HasProgress { get; init; }
        public string? CurrentLocator { get; init; }
        public string? SlugLocator { get; init; }
        public decimal? BookFraction { get; init; }
        public DateTimeOffset? CompletedAt { get; init; }
        public DateTimeOffset ClientRecordedAt { get; init; }
        public DateTimeOffset StateUpdatedAt { get; init; }
        public DateTimeOffset? TakedownAt { get; init; }
        public int Status { get; init; }
    }

    private sealed record LegacyFile
    {
        public Guid Id { get; init; }
        public Guid BookId { get; init; }
        public string OriginalName { get; init; } = "";
        public string StoragePath { get; init; } = "";
        public int Format { get; init; }
        public string? Sha256 { get; init; }
        public long ByteSize { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }

    private sealed record BookRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Title { get; init; } = "";
        public string? Author { get; init; }
        public string? Language { get; init; }
        public string? Description { get; init; }
        public string? Genre { get; init; }
        public int? PublishedYear { get; init; }
        public string[] Tags { get; init; } = [];
        public string? CoverKey { get; init; }
        public string Origin { get; init; } = "";
        public bool CheckpointSavingEnabled { get; init; }
        public long Revision { get; init; } = 1;
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public DateTimeOffset? RemovedAt { get; init; }
    }

    private sealed record FileRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public string Sha256 { get; init; } = "";
        public long ByteSize { get; init; }
        public string OriginalName { get; init; } = "";
        public string Format { get; init; } = "";
        public int? PageCount { get; init; }
        public string? Toc { get; init; }
        public string? ServerStorageKey { get; init; }
        public bool IsCurrent { get; init; } = true;
        public DateTimeOffset? ContentRemovedAt { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }
}
