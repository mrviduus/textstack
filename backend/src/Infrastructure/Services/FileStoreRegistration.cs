using Application.Common.Interfaces;
using Application.Library;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Infrastructure.Services;

/// <summary>
/// The two local file stores, one registration for the Api (and its CLI commands) and the Worker.
/// <c>Storage:RootPath</c> is public (<c>/storage</c>, nginx); <c>Storage:LibraryRoot</c> holds the V2
/// library on its own volume (#1110). The <c>/storage/library|uploads</c> denylist stays as defense in depth.
/// </summary>
public static class FileStoreRegistration
{
    /// <summary>The public static root; blank = unset.</summary>
    public static string StorageRoot(IConfiguration configuration) =>
        string.IsNullOrWhiteSpace(configuration["Storage:RootPath"]) ? "/storage" : configuration["Storage:RootPath"]!;

    /// <summary>The V2 library root; blank = unset.</summary>
    public static string LibraryRoot(IConfiguration configuration) =>
        string.IsNullOrWhiteSpace(configuration["Storage:LibraryRoot"]) ? "/library" : configuration["Storage:LibraryRoot"]!;

    /// <summary>
    /// Registers both stores. Throws when the roots nest or are equal (configuration only). V2 files left
    /// under the public root, or a part of it that cannot be scanned, only warn.
    /// </summary>
    public static IServiceCollection AddTextStackFileStores(this IServiceCollection services, IConfiguration configuration)
    {
        var (storage, library) = (StorageRoot(configuration), LibraryRoot(configuration));
        if (RootsAreNested(storage, library))
            throw new InvalidOperationException(
                $"Storage:LibraryRoot ({AsDirectory(library)}) and Storage:RootPath ({AsDirectory(storage)}) are nested, and /storage serves the root publicly. Make them separate directories, e.g. /library and /storage (#1110).");

        // Leftover V2 files under the public root: a warning in both modes, never a crash loop. The
        // /storage/library|uploads denylist (UserStoragePolicy, nginx) keeps them private meanwhile.
        // No logger exists yet at registration; stderr reaches `docker compose logs`.
        foreach (var dir in new[] { "library", "uploads" })
        {
            var leftover = Path.Combine(Path.GetFullPath(storage), dir);
            var (hasFiles, unreadable) = Scan(leftover);
            if (hasFiles)
                Console.Error.WriteLine(LeftoverWarning(leftover));
            if (unreadable is not null)
                Console.Error.WriteLine($"warn: V2 leftover scan incomplete: {unreadable} unreadable.");
        }

        services.AddSingleton<IFileStorageService>(new LocalFileStorageService(StorageRoot(configuration)));
        services.AddSingleton<ILibraryFileStore>(new LibraryFileStore(LibraryRoot(configuration)));
        return services;
    }

    /// <summary>
    /// Whether the roots nest or are equal. Either direction: the library inside the public root is served; the
    /// public root inside the library mixes the two, and the library's sweeps would walk public files.
    /// </summary>
    public static bool RootsAreNested(string storage, string library)
    {
        var (s, l) = (AsDirectory(storage), AsDirectory(library));
        // Ignoring case is stricter, and right on a case-insensitive disk (macOS).
        return l.StartsWith(s, StringComparison.OrdinalIgnoreCase) || s.StartsWith(l, StringComparison.OrdinalIgnoreCase);
    }

    // Full, with one trailing separator, so "/storage-x" is not inside "/storage" and "/" holds everything.
    internal static string AsDirectory(string root)
    {
        var full = Path.GetFullPath(root);
        return Path.EndsInDirectorySeparator(full) ? full : full + Path.DirectorySeparatorChar;
    }

    /// <summary>The fix, per directory and safe to re-run: copy into data/library/{dir}, then remove.</summary>
    public static string LeftoverWarning(string leftover) =>
        $"warn: {leftover} holds V2 files from before #1110, under the public root (404 by the denylist). Move them once on the host: " +
        "mkdir -p data/library && for d in library uploads; do [ -d data/storage/$d ] && cp -a data/storage/$d/. data/library/$d/ && rm -rf data/storage/$d; done; " +
        "sudo chown -R 1000:1000 data/library (make fix-permissions chowns data/library itself, not recursively).";

    private static readonly EnumerationOptions Files = new() { AttributesToSkip = 0, IgnoreInaccessible = false };

    // Symlinked directories are not followed: a cycle would never end.
    private static readonly EnumerationOptions Directories = new() { AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };

    /// <summary>Whether <paramref name="dir"/> holds a file at any depth, and the first directory that could not be read.</summary>
    public static (bool HasFiles, string? Unreadable) Scan(string dir)
    {
        if (!Directory.Exists(dir))
            return (false, null);
        var pending = new Stack<string>([dir]);
        string? unreadable = null;
        while (pending.TryPop(out var current))
        {
            try
            {
                if (Directory.EnumerateFiles(current, "*", Files).Any())
                    return (true, unreadable);
                foreach (var sub in Directory.EnumerateDirectories(current, "*", Directories))
                    pending.Push(sub);
            }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException)
            {
                unreadable ??= current;
            }
        }
        return (false, unreadable);
    }

    /// <summary>
    /// /health/ready's write probe: null when a file can be written to <paramref name="root"/>, else the
    /// error's type name. A file of its own per call, deleted in finally: one shared name raced between
    /// concurrent probes (one deleting the file another was about to delete: a false "down").
    /// </summary>
    public static async Task<string?> ProbeWriteAsync(string root, CancellationToken ct)
    {
        var probe = Path.Combine(root, $".health-probe-{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllTextAsync(probe, DateTimeOffset.UtcNow.ToString("O"), ct);
            return null;
        }
        catch (Exception ex)
        {
            return ex.GetType().Name;
        }
        finally
        {
            try { File.Delete(probe); } catch { /* nothing written, or already gone */ }
        }
    }
}
