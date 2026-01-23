using System.Diagnostics;
using System.Text.Json;
using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TextStack.Search.Abstractions;

namespace Application.TextStack;

public record SyncResult(
    int Total,
    int AlreadyImported,
    int Cloned,
    int Imported,
    int Failed,
    List<SyncBookResult> Books
);

public record SyncBookResult(string Identifier, string Status, string? Error);

public record RestoreResult(
    int TotalInDb,
    int AlreadyHaveSource,
    int MissingSource,
    int AvailableOnGitHub,
    int Restored,
    int Failed,
    List<SyncBookResult> Books
);

public class StandardEbooksSyncService
{
    private const string GitHubApiUrl = "https://api.github.com/orgs/standardebooks/repos";
    private const string GitHubCloneUrl = "https://github.com/standardebooks";

    private readonly IAppDbContext _db;
    private readonly IFileStorageService _storage;
    private readonly ISearchIndexer _searchIndexer;
    private readonly ILogger<StandardEbooksSyncService> _logger;
    private readonly HttpClient _httpClient;

    public StandardEbooksSyncService(
        IAppDbContext db,
        IFileStorageService storage,
        ISearchIndexer searchIndexer,
        ILogger<StandardEbooksSyncService> logger,
        HttpClient httpClient)
    {
        _db = db;
        _storage = storage;
        _searchIndexer = searchIndexer;
        _logger = logger;
        _httpClient = httpClient;

        // GitHub API requires User-Agent header
        if (!_httpClient.DefaultRequestHeaders.Contains("User-Agent"))
        {
            _httpClient.DefaultRequestHeaders.Add("User-Agent", "TextStack-Sync/1.0");
        }
    }

    public async Task<List<string>> GetAvailableBooksAsync(CancellationToken ct)
    {
        var repos = new List<string>();
        var page = 1;

        while (true)
        {
            var url = $"{GitHubApiUrl}?per_page=100&page={page}";
            _logger.LogInformation("Fetching GitHub repos page {Page}", page);

            var response = await _httpClient.GetAsync(url, ct);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync(ct);
            var reposPage = JsonSerializer.Deserialize<List<GitHubRepo>>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (reposPage == null || reposPage.Count == 0)
                break;

            // Filter to only book repos (exclude tools, web-*, etc.)
            var bookRepos = reposPage
                .Where(r => !r.Name.StartsWith("tools") &&
                            !r.Name.StartsWith("web-") &&
                            !r.Name.StartsWith("manual") &&
                            !r.Name.StartsWith(".") &&
                            r.Name.Contains('_')) // Books have author_title format
                .Select(r => r.Name)
                .ToList();

            repos.AddRange(bookRepos);
            _logger.LogInformation("Found {Count} book repos on page {Page}", bookRepos.Count, page);

            if (reposPage.Count < 100)
                break;

            page++;
        }

        _logger.LogInformation("Total available books from Standard Ebooks: {Count}", repos.Count);
        return repos;
    }

    public async Task<HashSet<string>> GetImportedIdentifiersAsync(Guid siteId, CancellationToken ct)
    {
        var identifiers = await _db.TextStackImports
            .Where(i => i.SiteId == siteId)
            .Select(i => i.Identifier)
            .ToListAsync(ct);

        return identifiers.ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public async Task<bool> CloneBookAsync(string identifier, string targetPath, CancellationToken ct)
    {
        var bookPath = Path.Combine(targetPath, identifier);

        if (Directory.Exists(bookPath))
        {
            _logger.LogInformation("Book already exists locally: {Identifier}", identifier);
            return true;
        }

        var cloneUrl = $"{GitHubCloneUrl}/{identifier}.git";
        _logger.LogInformation("Cloning {Identifier} from {Url}", identifier, cloneUrl);

        var psi = new ProcessStartInfo
        {
            FileName = "git",
            Arguments = $"clone --depth 1 {cloneUrl} {bookPath}",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi);
        if (process == null)
        {
            _logger.LogError("Failed to start git process");
            return false;
        }

        await process.WaitForExitAsync(ct);

        if (process.ExitCode != 0)
        {
            var error = await process.StandardError.ReadToEndAsync(ct);
            _logger.LogError("Git clone failed for {Identifier}: {Error}", identifier, error);
            return false;
        }

        _logger.LogInformation("Cloned {Identifier} successfully", identifier);
        return true;
    }

    public async Task<SyncResult> SyncAsync(Guid siteId, string targetPath, int? limit, CancellationToken ct)
    {
        var results = new List<SyncBookResult>();
        var cloned = 0;
        var imported = 0;
        var failed = 0;

        // 1. Get available books from GitHub
        var available = await GetAvailableBooksAsync(ct);
        var total = available.Count;

        // 2. Get already imported
        var alreadyImported = await GetImportedIdentifiersAsync(siteId, ct);
        var alreadyImportedCount = alreadyImported.Count;

        // 3. Find missing books
        var missing = available
            .Where(id => !alreadyImported.Contains(id))
            .ToList();

        if (limit.HasValue && limit.Value > 0)
        {
            missing = missing.Take(limit.Value).ToList();
        }

        _logger.LogInformation(
            "Sync: {Total} available, {Imported} already imported, {Missing} to sync",
            total, alreadyImportedCount, missing.Count);

        // 4. Clone and import missing books
        var importService = new TextStackImportService(_db, _storage, _searchIndexer,
            _logger as ILogger<TextStackImportService> ??
            Microsoft.Extensions.Logging.Abstractions.NullLogger<TextStackImportService>.Instance);

        foreach (var identifier in missing)
        {
            if (ct.IsCancellationRequested)
                break;

            try
            {
                // Clone
                var cloneSuccess = await CloneBookAsync(identifier, targetPath, ct);
                if (!cloneSuccess)
                {
                    results.Add(new SyncBookResult(identifier, "clone_failed", "Git clone failed"));
                    failed++;
                    continue;
                }
                cloned++;

                // Import
                var bookPath = Path.Combine(targetPath, identifier);
                var importResult = await importService.ImportBookAsync(siteId, bookPath, ct);

                if (importResult.WasSkipped)
                {
                    results.Add(new SyncBookResult(identifier, "skipped", null));
                }
                else if (importResult.Error != null)
                {
                    results.Add(new SyncBookResult(identifier, "import_failed", importResult.Error));
                    failed++;
                }
                else
                {
                    results.Add(new SyncBookResult(identifier, "imported", null));
                    imported++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error syncing {Identifier}", identifier);
                results.Add(new SyncBookResult(identifier, "error", ex.Message));
                failed++;
            }
        }

        return new SyncResult(total, alreadyImportedCount, cloned, imported, failed, results);
    }

    /// <summary>
    /// Restore source files for books that are in DB but don't have local source folders.
    /// Downloads from Standard Ebooks GitHub.
    /// </summary>
    public async Task<RestoreResult> RestoreSourcesAsync(Guid siteId, string targetPath, int? limit, CancellationToken ct)
    {
        var results = new List<SyncBookResult>();
        var restored = 0;
        var failed = 0;

        // 1. Get all imported identifiers from DB
        var importedIdentifiers = await GetImportedIdentifiersAsync(siteId, ct);
        var totalInDb = importedIdentifiers.Count;

        // 2. Check which ones already have local source folders
        var alreadyHaveSource = 0;
        var missingSource = new List<string>();

        foreach (var identifier in importedIdentifiers)
        {
            var bookPath = Path.Combine(targetPath, identifier);
            if (Directory.Exists(bookPath))
            {
                alreadyHaveSource++;
            }
            else
            {
                missingSource.Add(identifier);
            }
        }

        _logger.LogInformation(
            "Restore: {TotalInDb} in DB, {AlreadyHave} have source, {Missing} missing source",
            totalInDb, alreadyHaveSource, missingSource.Count);

        // 3. Get available books from GitHub to check which missing ones can be restored
        var availableOnGitHub = await GetAvailableBooksAsync(ct);
        var availableSet = availableOnGitHub.ToHashSet(StringComparer.OrdinalIgnoreCase);

        // 4. Filter to only those available on GitHub
        var canRestore = missingSource
            .Where(id => availableSet.Contains(id))
            .ToList();

        var availableOnGitHubCount = canRestore.Count;
        var notOnGitHub = missingSource.Count - canRestore.Count;

        _logger.LogInformation(
            "Restore: {CanRestore} available on GitHub, {NotOnGitHub} not available",
            canRestore.Count, notOnGitHub);

        // Apply limit
        if (limit.HasValue && limit.Value > 0)
        {
            canRestore = canRestore.Take(limit.Value).ToList();
        }

        // 5. Clone missing sources
        foreach (var identifier in canRestore)
        {
            if (ct.IsCancellationRequested)
                break;

            try
            {
                var cloneSuccess = await CloneBookAsync(identifier, targetPath, ct);
                if (cloneSuccess)
                {
                    results.Add(new SyncBookResult(identifier, "restored", null));
                    restored++;
                }
                else
                {
                    results.Add(new SyncBookResult(identifier, "clone_failed", "Git clone failed"));
                    failed++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error restoring source for {Identifier}", identifier);
                results.Add(new SyncBookResult(identifier, "error", ex.Message));
                failed++;
            }
        }

        return new RestoreResult(
            totalInDb,
            alreadyHaveSource,
            missingSource.Count,
            availableOnGitHubCount,
            restored,
            failed,
            results
        );
    }

    private class GitHubRepo
    {
        public string Name { get; set; } = "";
    }
}
