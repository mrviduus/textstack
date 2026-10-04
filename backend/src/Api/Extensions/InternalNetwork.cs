using System.Net;

namespace Api.Extensions;

/// <summary>
/// "Is this caller on the Docker network or the host?" — the only gate on <c>/internal/*</c>.
///
/// <para>Two holes the old per-file copies had: a missing remote address counted as local, and
/// <c>MapToIPv4()</c> on a plain IPv6 address returns its last 32 bits, so a chosen public IPv6
/// address could read as 10.x or 172.16/12. Now only a real IPv4-mapped address is unwrapped, and no
/// address means no access. nginx also refuses <c>/api/internal/</c> from outside.</para>
/// </summary>
public static class InternalNetwork
{
    private static readonly IPNetwork[] Allowed =
    [
        IPNetwork.Parse("10.0.0.0/8"),
        IPNetwork.Parse("172.16.0.0/12"),
    ];

    public static bool IsLocalRequest(HttpContext ctx) => IsLocal(ctx.Connection.RemoteIpAddress);

    public static bool IsLocal(IPAddress? remote)
    {
        if (remote is null) return false;
        if (IPAddress.IsLoopback(remote)) return true;
        if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
        return Allowed.Any(n => n.Contains(remote));
    }
}
