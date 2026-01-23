using Application.Common.Interfaces;
using Application.TextStack;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TextStack.Search.Abstractions;

namespace Worker.Services;

public class TextStackWatcher : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<TextStackWatcher> _logger;
    private readonly TimeSpan _scanInterval;

    public TextStackWatcher(
        IServiceScopeFactory scopeFactory,
        IConfiguration config,
        ILogger<TextStackWatcher> logger)
    {
        _scopeFactory = scopeFactory;
        _config = config;
        _logger = logger;
        _scanInterval = TimeSpan.FromMinutes(_config.GetValue("TextStack:ScanIntervalMinutes", 30));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("TextStack watcher started, scan interval: {Interval}", _scanInterval);

        // Initial delay to let other services start
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ScanAndImportAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in TextStack watcher scan");
            }

            await Task.Delay(_scanInterval, stoppingToken);
        }

        _logger.LogInformation("TextStack watcher stopped");
    }

    private async Task ScanAndImportAsync(CancellationToken ct)
    {
        var watchPath = _config["TextStack:WatchPath"];
        if (string.IsNullOrEmpty(watchPath) || !Directory.Exists(watchPath))
        {
            _logger.LogDebug("TextStack:WatchPath not configured or doesn't exist: {Path}", watchPath);
            return;
        }

        var defaultSiteIdStr = _config["TextStack:DefaultSiteId"];
        if (string.IsNullOrEmpty(defaultSiteIdStr) || !Guid.TryParse(defaultSiteIdStr, out var siteId))
        {
            _logger.LogWarning("TextStack:DefaultSiteId not configured or invalid");
            return;
        }

        _logger.LogInformation("Scanning TextStack folder: {Path}", watchPath);

        using var scope = _scopeFactory.CreateScope();
        var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<AppDbContext>>();
        await using var db = await dbFactory.CreateDbContextAsync(ct);

        var storage = scope.ServiceProvider.GetRequiredService<IFileStorageService>();
        var searchIndexer = scope.ServiceProvider.GetRequiredService<ISearchIndexer>();
        var logger = scope.ServiceProvider.GetRequiredService<ILogger<TextStackImportService>>();

        var importService = new TextStackImportService(db, storage, searchIndexer, logger);

        var imported = 0;
        var skipped = 0;
        var errors = 0;

        foreach (var bookDir in Directory.GetDirectories(watchPath))
        {
            if (ct.IsCancellationRequested)
                break;

            var opfPath = Path.Combine(bookDir, "src/epub/content.opf");
            if (!File.Exists(opfPath))
                continue;

            try
            {
                var result = await importService.ImportBookAsync(siteId, bookDir, ct);

                if (result.WasSkipped)
                    skipped++;
                else if (result.Error != null)
                {
                    errors++;
                    _logger.LogWarning("Failed to import {Book}: {Error}", Path.GetFileName(bookDir), result.Error);
                }
                else
                {
                    imported++;
                    _logger.LogInformation("Imported {Book}: {Chapters} chapters",
                        Path.GetFileName(bookDir), result.ChapterCount);
                }
            }
            catch (Exception ex)
            {
                errors++;
                _logger.LogWarning(ex, "Exception importing {Book}", Path.GetFileName(bookDir));
            }
        }

        _logger.LogInformation("TextStack scan complete: {Imported} imported, {Skipped} skipped, {Errors} errors",
            imported, skipped, errors);
    }
}
