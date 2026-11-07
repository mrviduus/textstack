using System.Buffers;
using System.Security.Cryptography;
using Application.Library;

namespace Infrastructure.Services;

/// <summary>
/// <see cref="ILibraryFileStore"/> on a local directory, <c>Storage:LibraryRoot</c> (<c>/library</c>, its own
/// volume outside the public <c>/storage</c> root, so nothing serves it but /me/v2; #1110). Layout under it:
/// <c>library/…</c> (the keys) and <c>uploads/{userId}/{fileId}/{index:D5}.part</c>. The user id is in every path, so one user's ids never reach
/// another's files. Ids are Guids and formats come from the database, so a key cannot climb out of the root.
/// </summary>
public sealed class LibraryFileStore(string root) : ILibraryFileStore
{
    /// <summary>How long an upload's parts wait for their complete (legacy's window).</summary>
    private static readonly TimeSpan StaleAfter = TimeSpan.FromDays(1);

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

    // The sweeps remove only directories older than an upload's or an attach's lifetime, so creating
    // the directory just before the file is enough.
    private static FileStream CreateFile(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        return File.Create(path);
    }

    public async Task<long?> SavePartAsync(Guid userId, Guid fileId, int index, Stream body, long maxBytes, CancellationToken ct)
    {
        var dir = UploadDir(userId, fileId);
        var temp = Path.Combine(dir, $"{index:D5}.{Guid.NewGuid():N}.tmp");
        var buffer = ArrayPool<byte>.Shared.Rent(BufferBytes);
        try
        {
            long written = 0;
            await using (var file = CreateFile(temp))
            {
                int read;
                // The cap is defensive: Kestrel already refuses a body longer than its Content-Length.
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
            ArrayPool<byte>.Shared.Return(buffer);
            TryDeleteFile(temp);
        }
    }

    public async Task<StagedContent?> AssembleAsync(Guid userId, Guid fileId, int partCount, string key, CancellationToken ct)
    {
        var dir = UploadDir(userId, fileId);
        // Before writing hundreds of MB that a missing last part would waste.
        if (!Enumerable.Range(0, partCount).All(i => File.Exists(PartPath(dir, i)))) return null;

        var temp = TempBeside(key);
        var buffer = ArrayPool<byte>.Shared.Rent(BufferBytes);
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long size = 0;
            await using (var output = CreateFile(temp))
            {
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
        catch (Exception e)
        {
            TryDeleteFile(temp);
            // A part deleted under us (a concurrent complete or the sweep): missing, as if never sent.
            if (e is FileNotFoundException or DirectoryNotFoundException) return null;
            throw;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
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
            return new StagedContent(key, temp, null, bytes.Length);
        }
        catch
        {
            TryDeleteFile(temp);
            throw;
        }
    }

    public void Place(StagedContent staged) => File.Move(staged.TempPath, FullPath(staged.Key), overwrite: true);

    public void Discard(StagedContent staged) => TryDeleteFile(staged.TempPath);

    public void DeleteParts(Guid userId, Guid fileId) => TryDeleteDirectory(UploadDir(userId, fileId));

    public void SweepStaleParts(DateTimeOffset now)
    {
        try
        {
            if (!Directory.Exists(UploadsDir)) return;
            foreach (var upload in Directory.EnumerateDirectories(UploadsDir).SelectMany(Directory.EnumerateDirectories))
                if (now.UtcDateTime - Directory.GetLastWriteTimeUtc(upload) > StaleAfter)
                    TryDeleteDirectory(upload);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public IEnumerable<string> EnumerateLibraryFilesOlderThan(DateTimeOffset cutoff)
    {
        var library = new DirectoryInfo(LibraryDir);
        if (!library.Exists) return [];
        return library.EnumerateFiles("*", SearchOption.AllDirectories)
            .Where(f => f.LastWriteTimeUtc < cutoff.UtcDateTime)
            .Select(f => Path.GetRelativePath(root, f.FullName).Replace(Path.DirectorySeparatorChar, '/'));
    }

    public void RemoveEmptyDirectories(DateTimeOffset olderThan)
    {
        foreach (var top in (string[])[LibraryDir, UploadsDir])
            if (Directory.Exists(top))
                foreach (var child in Directory.EnumerateDirectories(top))
                    RemoveIfEmpty(child, olderThan.UtcDateTime);
    }

    // Post-order: the children first, so a parent they emptied goes in the same pass. A young directory
    // stays: a write may be about to create its file.
    private static void RemoveIfEmpty(string dir, DateTime olderThan)
    {
        try
        {
            foreach (var child in Directory.EnumerateDirectories(dir).ToList()) RemoveIfEmpty(child, olderThan);
            if (Directory.GetLastWriteTimeUtc(dir) < olderThan && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    public string? Locate(string key) => File.Exists(FullPath(key)) ? FullPath(key) : null;

    public bool TryDelete(string key) => TryDeleteFile(FullPath(key));

    public void DeleteUser(Guid userId)
    {
        TryDeleteDirectory(FullPath(UserDir(userId)));
        TryDeleteDirectory(Path.Combine(UploadsDir, userId.ToString()));
    }

    private static bool TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
            return true;
        }
        // Its directory is gone, so the file is too.
        catch (DirectoryNotFoundException)
        {
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
