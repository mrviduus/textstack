using Application.Common.Interfaces;
using Application.Library;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Infrastructure.Services;

/// <summary>
/// The two local file stores, one registration for the Api and the Worker. <c>Storage:RootPath</c> is
/// public (<c>/storage</c>, nginx); <c>Storage:LibraryRoot</c> holds the V2 library and must be outside
/// it, since nothing denies <c>/storage/library</c> or <c>/storage/uploads</c> any more (#1110).
/// </summary>
public static class FileStoreRegistration
{
    public static string LibraryRoot(IConfiguration configuration) =>
        string.IsNullOrWhiteSpace(configuration["Storage:LibraryRoot"]) ? "/library" : configuration["Storage:LibraryRoot"]!;

    /// <summary>Registers both stores; throws at startup when the two roots nest or the V2 library would be public.</summary>
    public static IServiceCollection AddTextStackFileStores(this IServiceCollection services, IConfiguration configuration)
    {
        // As the Api's static files read it (Program.cs), so the check is against what /storage serves.
        var storageRoot = configuration["Storage:RootPath"] ?? "/storage";
        var storage = Path.GetFullPath(storageRoot);
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

        foreach (var dir in new[] { "library", "uploads" })
        {
            var leftover = Path.Combine(storage, dir);
            if (Directory.Exists(leftover) && Directory.EnumerateFiles(leftover, "*", SearchOption.AllDirectories).Any())
                throw new InvalidOperationException(
                    $"{leftover} holds V2 files from before #1110, which /storage would serve publicly. Move them once on the host, into an empty data/library: " +
                    "mv data/storage/library data/storage/uploads data/library/ (whichever exist) && make fix-permissions");
        }

        services.AddSingleton<IFileStorageService>(new LocalFileStorageService(storageRoot));
        services.AddSingleton<ILibraryFileStore>(new LibraryFileStore(LibraryRoot(configuration)));
        return services;
    }
}
