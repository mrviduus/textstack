using System.IO.Compression;

namespace TextStack.Extraction.Utilities;

/// <summary>
/// Size limits checked from the zip central directory before an EPUB is parsed. The parser loads
/// every entry into memory, so an archive that declares more than it is reasonable to inflate is
/// refused up front. The runtime's zip reader also refuses an entry that inflates past its declared
/// size, so the declared sizes are a real bound.
/// </summary>
public static class EpubArchiveGuard
{
    public const long MaxTotalUncompressedBytes = 500L * 1024 * 1024;
    public const int MaxEntries = 10_000;

    /// <summary>Null when the archive is within limits, else the reason. Leaves the stream at its original position.</summary>
    /// <exception cref="InvalidDataException">The stream is not a zip archive.</exception>
    public static string? Check(Stream content, long maxTotalBytes = MaxTotalUncompressedBytes, int maxEntries = MaxEntries)
    {
        // ponytail: a non-seekable stream cannot be rewound for the parser, so it is not checked; ingestion passes file streams.
        if (!content.CanSeek)
            return null;

        var start = content.Position;
        try
        {
            using var zip = new ZipArchive(content, ZipArchiveMode.Read, leaveOpen: true);
            if (zip.Entries.Count > maxEntries)
                return $"EPUB has {zip.Entries.Count} files; the limit is {maxEntries}.";

            long total = 0;
            foreach (var entry in zip.Entries)
            {
                total += entry.Length;
                if (total > maxTotalBytes)
                    return $"EPUB unpacks to more than {maxTotalBytes / 1024 / 1024} MB.";
            }
            return null;
        }
        finally
        {
            content.Position = start;
        }
    }
}
