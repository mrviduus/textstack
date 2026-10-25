namespace Application.UserBooks;

/// <summary>
/// Temp storage for chunked uploads. Cloudflare refuses any single request body over ~100 MB with a 413
/// before it reaches us (EntitlementOptions.MaxSingleUploadBytes), so a bigger book arrives as parts:
/// each part is one request under that ceiling, and <see cref="AssembleAsync"/> joins them into one
/// seekable file that goes through the normal <see cref="UserBookService.UploadAsync"/> path.
///
/// Layout: <c>{root}/{userId}/{uploadId}/{index:D5}.part</c>. The user id is in the path, so an upload id
/// can never reach another user's parts. The client picks the upload id; no init call, no DB row.
/// Everything a user has in flight lives under their directory, which is what the quota and the sweep see.
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

    /// <summary>
    /// Every byte this user has on temp disk — all uploads, in-flight parts included — except the stored
    /// part at <paramref name="exceptIndex"/> of <paramref name="uploadId"/> (a part being re-sent replaces it).
    /// Checking the quota against this, not one upload, stops many parallel upload ids from filling the disk.
    /// </summary>
    public long UserBytes(Guid userId, Guid uploadId, int exceptIndex)
    {
        var userDir = UserDir(userId);
        if (!Directory.Exists(userDir)) return 0;
        var skip = PartPath(UploadDir(userId, uploadId), exceptIndex);
        return Directory.EnumerateFiles(userDir, "*", SearchOption.AllDirectories)
            .Where(f => f != skip)
            .Sum(SizeOrZero);
    }

    /// <summary>Bytes stored for one upload's parts, excluding <paramref name="exceptIndex"/>.</summary>
    public long UploadBytes(Guid userId, Guid uploadId, int exceptIndex = -1)
    {
        var dir = UploadDir(userId, uploadId);
        if (!Directory.Exists(dir)) return 0;
        var skip = exceptIndex >= 0 ? PartPath(dir, exceptIndex) : null;
        return Directory.EnumerateFiles(dir, "*.part").Where(f => f != skip).Sum(SizeOrZero);
    }

    // A file can vanish between listing and sizing (a concurrent request finishing); count it as gone.
    private static long SizeOrZero(string path)
    {
        try { return new FileInfo(path).Length; }
        catch (FileNotFoundException) { return 0; }
    }

    /// <summary>
    /// Stores one part, replacing an earlier attempt at the same index (a retried request). Reads at most
    /// <paramref name="maxBytes"/>: a body without Content-Length cannot slip past the per-part ceiling.
    /// Returns the part's size, or null if it was empty or over the ceiling. Nothing partial is ever kept —
    /// not on refusal, and not when the client aborts mid-part.
    /// </summary>
    public async Task<long?> SavePartAsync(
        Guid userId, Guid uploadId, int index, Stream body, long maxBytes, CancellationToken ct)
    {
        if (index is < 0 or >= MaxParts) return null;

        var dir = UploadDir(userId, uploadId);
        Directory.CreateDirectory(dir);
        var temp = Path.Combine(dir, $"{index:D5}.{Guid.NewGuid():N}.tmp");

        try
        {
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

            if (written == 0 || written > maxBytes) return null;

            File.Move(temp, PartPath(dir, index), overwrite: true);
            return written;
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    /// <summary>
    /// Joins parts <c>0..partCount-1</c> into one file and removes the parts. The upload directory is first
    /// renamed (atomic): a second complete for the same upload finds nothing and gets null, so one upload
    /// can never become two books or fail mid-copy. The returned stream is seekable (UploadAsync checks the
    /// quota by length) and removes its directory when disposed; after a crash, the directory still sits
    /// under the user's, where <see cref="SweepStale"/> finds it. Null if the upload is unknown or a part
    /// is missing — then the parts are put back, so the client can re-send the missing one.
    /// </summary>
    public async Task<Stream?> AssembleAsync(Guid userId, Guid uploadId, int partCount, CancellationToken ct)
    {
        if (partCount is < 1 or > MaxParts) return null;

        var dir = UploadDir(userId, uploadId);
        var claimed = $"{dir}.assembling-{Guid.NewGuid():N}";
        try { Directory.Move(dir, claimed); }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; }

        var parts = Enumerable.Range(0, partCount).Select(i => PartPath(claimed, i)).ToList();
        if (!parts.All(File.Exists))
        {
            Directory.Move(claimed, dir);
            return null;
        }

        var output = new AssembledFile(claimed);
        try
        {
            foreach (var part in parts)
            {
                await using (var input = File.OpenRead(part))
                    await input.CopyToAsync(output, ct);
                File.Delete(part);
            }
            output.Position = 0;
            return output;
        }
        catch
        {
            await output.DisposeAsync();
            throw;
        }
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

    /// <summary>The joined book: lives in the claimed directory and takes the directory with it on dispose.</summary>
    private sealed class AssembledFile(string dir) : FileStream(
        Path.Combine(dir, "assembled"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920)
    {
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing) TryDeleteDir();
        }

        public override async ValueTask DisposeAsync()
        {
            await base.DisposeAsync();
            TryDeleteDir();
        }

        private void TryDeleteDir()
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
