namespace Application.UserBooks;

/// <summary>
/// Temp storage for chunked uploads. Cloudflare refuses any single request body over ~100 MB with a 413
/// before it reaches us (EntitlementOptions.MaxSingleUploadBytes), so a bigger book arrives as parts:
/// each part is one request under that ceiling, and <see cref="AssembleAsync"/> joins them into one
/// seekable file that goes through the normal <see cref="UserBookService.UploadAsync"/> path.
///
/// Layout: <c>{root}/{userId}/{uploadId}/{index:D5}.part</c>. The user id is in the path, so an upload id
/// can never reach another user's parts. The client picks the upload id; no init call, no DB row.
/// </summary>
public sealed class ChunkedUploadStore(string root)
{
    public const int MaxParts = 1000;

    // ponytail: an abandoned upload is swept on the user's next part request, not by a background job;
    // add one if disk use from abandoned uploads ever shows up. A restart of the Api drops temp parts.
    public static readonly TimeSpan StaleAfter = TimeSpan.FromDays(1);

    private string UserDir(Guid userId) => Path.Combine(root, userId.ToString("N"));
    private string UploadDir(Guid userId, Guid uploadId) => Path.Combine(UserDir(userId), uploadId.ToString("N"));
    private static string PartPath(string dir, int index) => Path.Combine(dir, $"{index:D5}.part");

    /// <summary>Bytes already stored for this upload, excluding <paramref name="exceptIndex"/> (a part being re-sent).</summary>
    public long StoredBytes(Guid userId, Guid uploadId, int exceptIndex = -1)
    {
        var dir = UploadDir(userId, uploadId);
        if (!Directory.Exists(dir)) return 0;
        var skip = exceptIndex >= 0 ? PartPath(dir, exceptIndex) : null;
        return Directory.EnumerateFiles(dir, "*.part").Where(f => f != skip).Sum(f => new FileInfo(f).Length);
    }

    /// <summary>
    /// Stores one part, replacing an earlier attempt at the same index (a retried request). Reads at most
    /// <paramref name="maxBytes"/>: a body without Content-Length cannot slip past the per-part ceiling.
    /// Returns the part's size, or null if it was empty or over the ceiling (nothing is kept).
    /// </summary>
    public async Task<long?> SavePartAsync(
        Guid userId, Guid uploadId, int index, Stream body, long maxBytes, CancellationToken ct)
    {
        if (index is < 0 or >= MaxParts) return null;

        var dir = UploadDir(userId, uploadId);
        Directory.CreateDirectory(dir);
        var temp = Path.Combine(dir, $"{index:D5}.{Guid.NewGuid():N}.tmp");

        long written = 0;
        await using (var file = File.Create(temp))
        {
            var buffer = new byte[81920];
            int read;
            while ((read = await body.ReadAsync(buffer, ct)) > 0)
            {
                written += read;
                if (written > maxBytes) break;
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
            }
        }

        if (written == 0 || written > maxBytes)
        {
            File.Delete(temp);
            return null;
        }

        File.Move(temp, PartPath(dir, index), overwrite: true);
        return written;
    }

    /// <summary>
    /// Joins parts <c>0..partCount-1</c> into one temp file and removes the parts. The returned stream is
    /// seekable (UploadAsync checks the quota by length) and deletes its file when disposed. Null if any part
    /// is missing — the parts are kept, so the client can re-send the missing one and complete again.
    /// </summary>
    public async Task<Stream?> AssembleAsync(Guid userId, Guid uploadId, int partCount, CancellationToken ct)
    {
        var dir = UploadDir(userId, uploadId);
        if (partCount is < 1 or > MaxParts || !Directory.Exists(dir)) return null;

        var parts = Enumerable.Range(0, partCount).Select(i => PartPath(dir, i)).ToList();
        if (!parts.All(File.Exists)) return null;

        var assembled = Path.Combine(root, $"{userId:N}-{uploadId:N}-{Guid.NewGuid():N}.assembled");
        var output = new FileStream(
            assembled, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose);
        try
        {
            foreach (var part in parts)
            {
                await using var input = File.OpenRead(part);
                await input.CopyToAsync(output, ct);
            }
            output.Position = 0;
        }
        catch
        {
            await output.DisposeAsync();
            throw;
        }

        Delete(userId, uploadId);
        return output;
    }

    public void Delete(Guid userId, Guid uploadId)
    {
        var dir = UploadDir(userId, uploadId);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    /// <summary>Removes this user's uploads untouched for <see cref="StaleAfter"/>. Never throws.</summary>
    public void SweepStale(Guid userId, DateTime utcNow)
    {
        try
        {
            var userDir = UserDir(userId);
            if (!Directory.Exists(userDir)) return;
            foreach (var dir in Directory.EnumerateDirectories(userDir))
                if (utcNow - Directory.GetLastWriteTimeUtc(dir) > StaleAfter)
                    Directory.Delete(dir, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
