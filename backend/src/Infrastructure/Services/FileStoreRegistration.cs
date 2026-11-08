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
    /// under the public root fail startup with Features:V2Api on, and only warn with it off: the legacy
    /// site must not go down for them, and the denylist still keeps them private.
    /// </summary>
    public static IServiceCollection AddTextStackFileStores(this IServiceCollection services, IConfiguration configuration)
    {
        var storage = Path.GetFullPath(StorageRoot(configuration));
        var library = Path.GetFullPath(LibraryRoot(configuration));
        // Both with one trailing separator, so "/storage-x" is not inside "/storage" and "/" holds everything.
        // Ignoring case is stricter, and right on a case-insensitive disk (macOS).
        if (!Path.EndsInDirectorySeparator(library))
            library += Path.DirectorySeparatorChar;
        if (!Path.EndsInDirectorySeparator(storage))
            storage += Path.DirectorySeparatorChar;
        // Either direction: the library inside the public root is served; the public root inside the
        // library mixes the two, and the library's sweeps would walk public files.
        if (library.StartsWith(storage, StringComparison.OrdinalIgnoreCase) || storage.StartsWith(library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                $"Storage:LibraryRoot ({library}) and Storage:RootPath ({storage}) are nested, and /storage serves the root publicly. Make them separate directories, e.g. /library and /storage (#1110).");

        var everything = new EnumerationOptions { IgnoreInaccessible = true, RecurseSubdirectories = true };
        foreach (var dir in new[] { "library", "uploads" })
        {
            var leftover = Path.Combine(storage, dir);
            if (!Directory.Exists(leftover) || !Directory.EnumerateFiles(leftover, "*", everything).Any())
                continue;
            var message = $"{leftover} holds V2 files from before #1110, under the public root. Move them once on the host, into an empty data/library: " +
                "mv data/storage/library data/storage/uploads data/library/ (whichever exist) && make fix-permissions";
            if (configuration.GetValue<bool>("Features:V2Api"))
                throw new InvalidOperationException(message);
            // No logger exists yet at registration; stderr reaches `docker compose logs`.
            Console.Error.WriteLine("warn: " + message);
        }

        services.AddSingleton<IFileStorageService>(new LocalFileStorageService(StorageRoot(configuration)));
        services.AddSingleton<ILibraryFileStore>(new LibraryFileStore(LibraryRoot(configuration)));
        return services;
    }
}
