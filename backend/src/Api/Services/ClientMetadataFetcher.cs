using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Api.Services;

/// <summary>
/// Fetches a Client ID Metadata Document (CIMD): an OAuth client whose <c>client_id</c> is an https
/// URL it hosts, describing its name and redirect URIs. This is an outbound request to a URL a
/// stranger chose, so it is SSRF-guarded:
/// <list type="bullet">
///   <item>https on the default port only, a real path, no userinfo/fragment;</item>
///   <item>every address the host resolves to must be public — checked inside the connect callback,
///     against the same resolution the socket then uses, so DNS rebinding cannot swap in
///     127.0.0.1 between check and connect;</item>
///   <item>no redirects, 5 s timeout, 16 KB body cap.</item>
/// </list>
/// Returns an error string rather than throwing — a bad document is the client's problem, reported
/// back as <c>invalid_client</c>.
/// </summary>
public sealed class ClientMetadataFetcher(HttpClient http)
{
    public const string HttpClientName = "oauth-cimd";
    internal const int MaxBytes = 16 * 1024;

    public sealed record Document(string ClientName, string[] RedirectUris);

    /// <summary>True when <paramref name="clientId"/> should be treated as a CIMD URL at all.</summary>
    public static bool IsMetadataUrl(string? clientId) =>
        clientId is not null && clientId.StartsWith("https://", StringComparison.Ordinal);

    /// <summary>Shape rules that need no network. Null when fine, else the reason.</summary>
    internal static string? ValidateUrl(string clientId)
    {
        if (clientId.Length > 512) return "client_id is too long";
        if (!Uri.TryCreate(clientId, UriKind.Absolute, out var uri)) return "client_id is not a URL";
        if (uri.Scheme != Uri.UriSchemeHttps) return "client_id must be https";
        if (!uri.IsDefaultPort) return "client_id must use the default port";
        if (uri.UserInfo.Length > 0 || uri.Fragment.Length > 0) return "client_id must not carry userinfo or a fragment";
        if (uri.AbsolutePath.Length <= 1) return "client_id must have a path";
        if (IPAddress.TryParse(uri.IdnHost.Trim('[', ']'), out var literal) && !IsPublicAddress(literal))
            return "client_id host is not public";
        return null;
    }

    public async Task<(Document? Doc, string? Error)> FetchAsync(string clientId, CancellationToken ct)
    {
        if (ValidateUrl(clientId) is { } shapeError) return (null, shapeError);

        try
        {
            using var response = await http.GetAsync(clientId, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode != HttpStatusCode.OK) return (null, $"client metadata answered {(int)response.StatusCode}");
            if (response.Content.Headers.ContentLength > MaxBytes) return (null, "client metadata too large");

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[MaxBytes + 1];
            var read = 0;
            int n;
            while (read < buffer.Length && (n = await stream.ReadAsync(buffer.AsMemory(read), ct)) > 0)
                read += n;
            if (read > MaxBytes) return (null, "client metadata too large");

            return Parse(clientId, buffer.AsSpan(0, read));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return (null, "client metadata could not be fetched");
        }
    }

    /// <summary>The document must name itself (client_id == URL) and list redirect URIs.</summary>
    internal static (Document? Doc, string? Error) Parse(string clientId, ReadOnlySpan<byte> json)
    {
        using var doc = JsonDocument.Parse(json.ToArray());
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return (null, "client metadata is not an object");

        if (!root.TryGetProperty("client_id", out var id) || id.GetString() != clientId)
            return (null, "client metadata client_id does not match its URL");

        if (root.TryGetProperty("token_endpoint_auth_method", out var method)
            && method.GetString() is { } m && m != "none")
            return (null, "only public clients (token_endpoint_auth_method=none) are supported");

        if (!root.TryGetProperty("redirect_uris", out var uris) || uris.ValueKind != JsonValueKind.Array)
            return (null, "client metadata has no redirect_uris");
        var redirectUris = uris.EnumerateArray()
            .Where(u => u.ValueKind == JsonValueKind.String)
            .Select(u => u.GetString()!)
            .ToArray();
        if (redirectUris.Length == 0) return (null, "client metadata has no redirect_uris");

        var name = root.TryGetProperty("client_name", out var n) ? n.GetString() : null;
        if (string.IsNullOrWhiteSpace(name)) name = new Uri(clientId).Host;

        return (new Document(name.Trim(), redirectUris), null);
    }

    /// <summary>
    /// The HTTP handler for this client: no redirects, no proxy, and a connect callback that refuses
    /// any non-public address. Wired in <c>Program.cs</c>.
    /// </summary>
    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        ConnectTimeout = TimeSpan.FromSeconds(5),
        ConnectCallback = async (context, ct) =>
        {
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
            if (addresses.Length == 0 || !addresses.All(IsPublicAddress))
                throw new HttpRequestException("client metadata host resolves to a non-public address");

            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        },
    };

    private static readonly IPNetwork[] NonPublic =
    [
        IPNetwork.Parse("0.0.0.0/8"),
        IPNetwork.Parse("10.0.0.0/8"),
        IPNetwork.Parse("100.64.0.0/10"),   // CGNAT
        IPNetwork.Parse("127.0.0.0/8"),
        IPNetwork.Parse("169.254.0.0/16"),  // link-local, cloud metadata
        IPNetwork.Parse("172.16.0.0/12"),
        IPNetwork.Parse("192.0.0.0/24"),
        IPNetwork.Parse("192.168.0.0/16"),
        IPNetwork.Parse("198.18.0.0/15"),
        IPNetwork.Parse("224.0.0.0/3"),     // multicast + reserved + broadcast
        IPNetwork.Parse("::/128"),
        IPNetwork.Parse("::1/128"),
        IPNetwork.Parse("64:ff9b::/96"),    // NAT64 — can front a private v4
        IPNetwork.Parse("fc00::/7"),        // ULA
        IPNetwork.Parse("fe80::/10"),       // link-local
        IPNetwork.Parse("ff00::/8"),        // multicast
    ];

    internal static bool IsPublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        return !NonPublic.Any(net => net.Contains(address));
    }
}
