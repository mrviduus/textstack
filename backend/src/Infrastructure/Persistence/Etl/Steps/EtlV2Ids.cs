using System.Security.Cryptography;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Deterministic ids of the rows etl-v2 derives (v2-plan §5.2), so a re-run computes the same rows:
/// RFC 9562 UUIDv5 under <see cref="Namespace"/>. Names are the ids' big-endian (RFC) bytes.
/// </summary>
public static class EtlV2Ids
{
    /// <summary><c>uuid_v5(nil, "textstack-v2")</c>: the namespace of every id etl-v2 derives.</summary>
    public static readonly Guid Namespace = V5(Guid.Empty, "textstack-v2"u8.ToArray());

    /// <summary>A catalog pair's book: <c>uuid_v5('textstack-v2', user ‖ edition)</c>.</summary>
    public static Guid CatalogBook(Guid userId, Guid editionId) =>
        V5(Namespace, [.. userId.ToByteArray(bigEndian: true), .. editionId.ToByteArray(bigEndian: true)]);

    /// <summary>An example's or review's <c>operation_id</c>: <c>uuid_v5('textstack-v2', legacy row id)</c>.</summary>
    public static Guid Operation(Guid legacyId) => V5(Namespace, legacyId.ToByteArray(bigEndian: true));

    public static Guid V5(Guid ns, byte[] name)
    {
        var hash = SHA1.HashData([.. ns.ToByteArray(bigEndian: true), .. name]);
        hash[6] = (byte)((hash[6] & 0x0F) | 0x50);
        hash[8] = (byte)((hash[8] & 0x3F) | 0x80);
        return new Guid(hash.AsSpan(0, 16), bigEndian: true);
    }
}
