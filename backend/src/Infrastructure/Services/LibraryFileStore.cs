using System.Security.Cryptography;
using Application.Library;
using Microsoft.Extensions.Configuration;

namespace Infrastructure.Services;

/// <summary>
/// <see cref="ILibraryFileStore"/> on a local directory. Layout under the root: <c>library/…</c> (the keys)
/// and <c>uploads/{userId}/{fileId}/{index:D5}.part</c>. The user id is in every path, so one user's
/// ids never reach another's files. Ids are Guids and formats come from the database, so a key cannot
/// climb out of the root.
/// </summary>
public sealed class LibraryFileStore(string root) : ILibraryFileStore
{
    /// <summary>
    /// <c>Storage:LibraryRoot</c>, by default <c>Storage:RootPath</c> (the persistent volume), so the keys
    /// <c>library/…</c> and the parts <c>uploads/…</c> sit directly on it (plan §4.5) and survive a restart.
    /// The public <c>/storage</c> root therefore refuses <c>/storage/library</c> and <c>/storage/uploads</c>
    /// (<c>UserStoragePolicy</c>, nginx).
    /// </summary>
    public static string RootOf(IConfiguration config) =>
        config["Storage:LibraryRoot"] ?? config["Storage:RootPath"] ?? "/storage";

    private const int BufferBytes = 81920;

    public string FileKey(Guid userId, Guid bookId, Guid fileId, string format) => $"{BookDir(userId, bookId)}/{fileId}.{format}";

    public string CoverKey(Guid userId, Guid bookId, string extension) => $"{BookDir(userId, bookId)}/cover.{extension}";

    private static string BookDir(Guid userId, Guid bookId) => $"{UserDir(userId)}/{bookId}";

    private static string UserDir(Guid userId) => $"library/{userId.ToString()[..2]}/{userId}";

    private string FullPath(string key) => Path.Combine(root, key);

    private string LibraryDir => Path.Combine(root, "library");

    private string UploadsDir => Path.Combine(root, "uploads");

    private string UploadDir(Guid userId, Guid fileId) => Path.Combine(UploadsDir, userId.ToString(), fileId.ToString());

    private static string PartPath(string dir, int index) => Path.Combine(dir, $"{index:D5}.part");

    // The sweeps remove old and empty directories while a request may be writing into one: create it
    // again and retry once, so a write never fails for a directory a sweep just took.
    private static FileStream CreateFile(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        try
        {
            return File.Create(path);
        }
        catch (DirectoryNotFoundException)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            return File.Create(path);
        }
    }

    public async Task<long?> SavePartAsync(Guid userId, Guid fileId, int index, Stream body, long maxBytes, CancellationToken ct)
    {
        var dir = UploadDir(userId, fileId);
        var temp = Path.Combine(dir, $"{index:D5}.{Guid.NewGuid():N}.tmp");
        try
        {
            long written = 0;
            await using (var file = CreateFile(temp))
            {
                var buffer = new byte[BufferBytes];
                int read;
                while ((read = await body.ReadAsync(buffer, ct)) > 0)
                {
                    written += read;
                    if (written > maxBytes) return null;
                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                }
            }
            if (written == 0) return null;
            File.Move(temp, PartPath(dir, index), overwrite: true);
            return written;
        }
        finally
        {
            TryDelete(temp);
        }
    }

    public (long User, long File) PartBytes(Guid userId, Guid fileId, int exceptIndex)
    {
        var userDir = Path.Combine(UploadsDir, userId.ToString());
        if (!Directory.Exists(userDir)) return (0, 0);
        var fileDir = UploadDir(userId, fileId) + Path.DirectorySeparatorChar;
        var skip = PartPath(UploadDir(userId, fileId), exceptIndex);
        long user = 0, file = 0;
        foreach (var path in Directory.EnumerateFiles(userDir, "*", SearchOption.AllDirectories))
        {
            if (path == skip) continue;
            var size = SizeOrZero(path);
            user += size;
            if (path.StartsWith(fileDir, StringComparison.Ordinal)) file += size;
        }
        return (user, file);
    }

    // A file can vanish between listing and sizing (a complete or a sweep): count it as gone.
    private static long SizeOrZero(string path)
    {
        try { return new FileInfo(path).Length; }
        catch (FileNotFoundException) { return 0; }
    }

    public async Task<StagedContent?> AssembleAsync(Guid userId, Guid fileId, int partCount, string key, CancellationToken ct)
    {
        var dir = UploadDir(userId, fileId);
        // Before writing hundreds of MB that a missing last part would waste.
        if (!Enumerable.Range(0, partCount).All(i => File.Exists(PartPath(dir, i)))) return null;

        var temp = TempBeside(key);
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long size = 0;
            await using (var output = CreateFile(temp))
            {
                var buffer = new byte[BufferBytes];
                for (var i = 0; i < partCount; i++)
                {
                    await using var input = File.OpenRead(PartPath(dir, i));
                    int read;
                    while ((read = await input.ReadAsync(buffer, ct)) > 0)
                    {
                        hash.AppendData(buffer, 0, read);
                        await output.WriteAsync(buffer.AsMemory(0, read), ct);
                        size += read;
                    }
                }
            }
            return new StagedContent(key, temp, Convert.ToHexStringLower(hash.GetHashAndReset()), size);
        }
        // A part deleted under us (a concurrent complete or the sweep): missing, as if never sent.
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            TryDelete(temp);
            return null;
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    // Next to the target, so placing it is a rename on the same volume.
    private string TempBeside(string key) => $"{FullPath(key)}.{Guid.NewGuid():N}.tmp";

    public async Task<StagedContent> StageAsync(string key, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        var temp = TempBeside(key);
        try
        {
            await using (var file = CreateFile(temp))
                await file.WriteAsync(bytes, ct);
            return new StagedContent(key, temp, Convert.ToHexStringLower(SHA256.HashData(bytes.Span)), bytes.Length);
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    public void Place(StagedContent staged) => File.Move(staged.TempPath, FullPath(staged.Key), overwrite: true);

    public void Discard(StagedContent staged) => TryDelete(staged.TempPath);

    public void DeleteParts(Guid userId, Guid fileId) => TryDeleteDirectory(UploadDir(userId, fileId));

    public void SweepStaleParts(DateTimeOffset now)
    {
        try
        {
            if (!Directory.Exists(UploadsDir)) return;
            foreach (var upload in Directory.EnumerateDirectories(UploadsDir).SelectMany(Directory.EnumerateDirectories))
                if (now.UtcDateTime - Directory.GetLastWriteTimeUtc(upload) > ILibraryFileStore.StaleAfter)
                    TryDeleteDirectory(upload);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public IReadOnlyList<string> ListLibraryFilesOlderThan(DateTimeOffset cutoff)
    {
        if (!Directory.Exists(LibraryDir)) return [];
        return Directory.EnumerateFiles(LibraryDir, "*", SearchOption.AllDirectories)
            .Where(path => File.GetLastWriteTimeUtc(path) < cutoff.UtcDateTime)
            .Select(path => Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/'))
            .ToList();
    }

    public void RemoveEmptyDirectories()
    {
        foreach (var top in (string[])[LibraryDir, UploadsDir])
        {
            if (!Directory.Exists(top)) continue;
            // Deepest first, so a parent emptied by its children goes in the same pass.
            foreach (var dir in Directory.EnumerateDirectories(top, "*", SearchOption.AllDirectories).OrderByDescending(d => d.Length).ToList())
            {
                try
                {
                    if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    public string? Locate(string key) => File.Exists(FullPath(key)) ? FullPath(key) : null;

    public void Delete(string key)
    {
        var path = FullPath(key);
        if (File.Exists(path)) File.Delete(path);
    }

    public void DeleteUser(Guid userId)
    {
        TryDeleteDirectory(FullPath(UserDir(userId)));
        TryDeleteDirectory(Path.Combine(UploadsDir, userId.ToString()));
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
