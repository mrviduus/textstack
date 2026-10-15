using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TextStack.Tts;

/// <summary>
/// Low-level client for Microsoft Edge's free TTS WebSocket API.
/// No external dependencies — uses System.Net.WebSockets.ClientWebSocket.
/// Protocol based on https://github.com/rany2/edge-tts
/// </summary>
internal static class EdgeTtsClient
{
    private const string TrustedClientToken = EdgeTtsDrm.TrustedClientToken;
    private const string Major = EdgeTtsDrm.ChromiumMajorVersion;
    private const string WssBase = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    private const string VoiceListUrl = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=" + TrustedClientToken;
    private const string OutputFormat = "audio-24khz-48kbitrate-mono-mp3";
    // Upstream BASE_HEADERS: major version only (143.0.0.0), like a real Edge UA.
    private const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + Major + ".0.0.0 Safari/537.36 Edg/" + Major + ".0.0.0";

    // Shared HttpClient — the anti-pattern of `new HttpClient()` per call
    // exhausts sockets under load (TIME_WAIT buildup). This endpoint is
    // currently called at most once per process (voice list cached), but
    // keeping the pattern correct prevents future regression.
    // AutomaticDecompression adds its own Accept-Encoding (gzip, deflate, br);
    // upstream also offers zstd, which .NET can't decode, so we don't.
    private static readonly HttpClient SharedHttp = new(new SocketsHttpHandler
    {
        AutomaticDecompression = System.Net.DecompressionMethods.All
    })
    {
        Timeout = TimeSpan.FromSeconds(15)
    };

    private static string GecQuery() =>
        $"&Sec-MS-GEC={EdgeTtsDrm.GenerateSecMsGec()}&Sec-MS-GEC-Version={EdgeTtsDrm.SecMsGecVersion}";

    // Upstream Communicate.stream / list_voices: on 403, correct the clock
    // from the server's Date header and retry exactly once.
    private static async Task<ClientWebSocket> ConnectAsync(CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var ws = new ClientWebSocket();
            ws.Options.CollectHttpResponseDetails = true;
            ws.Options.SetRequestHeader("Pragma", "no-cache");
            ws.Options.SetRequestHeader("Cache-Control", "no-cache");
            ws.Options.SetRequestHeader("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
            ws.Options.SetRequestHeader("User-Agent", UserAgent);
            ws.Options.SetRequestHeader("Accept-Encoding", "gzip, deflate, br, zstd");
            ws.Options.SetRequestHeader("Accept-Language", "en-US,en;q=0.9");
            ws.Options.SetRequestHeader("Cookie", $"muid={GenerateMuid()};");
            var url = $"{WssBase}?TrustedClientToken={TrustedClientToken}&ConnectionId={Guid.NewGuid():N}{GecQuery()}";
            try
            {
                await ws.ConnectAsync(new Uri(url), ct);
                return ws;
            }
            catch (WebSocketException) when (attempt == 0 && ws.HttpStatusCode == System.Net.HttpStatusCode.Forbidden
                && EdgeTtsDrm.AdjustClockSkew(ServerDate(ws.HttpResponseHeaders)))
            {
                ws.Dispose();
            }
            catch
            {
                ws.Dispose();
                throw;
            }
        }
    }

    private static string? ServerDate(IReadOnlyDictionary<string, IEnumerable<string>>? headers) =>
        headers is not null && headers.TryGetValue("Date", out var v) ? v.FirstOrDefault() : null;

    public static async Task<(byte[] Audio, List<WordTimestamp> Timestamps)> SynthesizeAsync(string text, string voice, string rate, string volume, string pitch, string lang, CancellationToken ct, long maxAudioBytes = 5L * 1024 * 1024)
    {
        using var ws = await ConnectAsync(ct);

        // 1. Send config
        var configMessage =
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            JsonSerializer.Serialize(new
            {
                context = new
                {
                    synthesis = new
                    {
                        audio = new
                        {
                            metadataoptions = new { sentenceBoundaryEnabled = "false", wordBoundaryEnabled = "true" },
                            outputFormat = OutputFormat
                        }
                    }
                }
            });
        await SendTextAsync(ws, configMessage, ct);

        // 2. Send SSML
        var requestId = Guid.NewGuid().ToString("N");
        var timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        var escapedText = System.Security.SecurityElement.Escape(text);
        // Derive BCP-47 lang tag from the voice name (e.g. "de-DE-KatjaNeural"
        // → "de-DE"). Hardcoding en-US was semantically wrong for non-English
        // voices; engines generally respect <voice> but xml:lang affects
        // fallback processing and should match.
        var xmlLang = ResolveXmlLang(voice, lang);
        var escapedLang = System.Security.SecurityElement.Escape(xmlLang);
        var escapedVoice = System.Security.SecurityElement.Escape(voice);
        var ssml =
            $"X-RequestId:{requestId}\r\n" +
            "Content-Type:application/ssml+xml\r\n" +
            $"X-Timestamp:{timestamp}\r\n" +
            "Path:ssml\r\n\r\n" +
            $"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{escapedLang}'>" +
            $"<voice name='{escapedVoice}'><prosody pitch='{pitch}' rate='{rate}' volume='{volume}'>{escapedText}</prosody></voice></speak>";
        await SendTextAsync(ws, ssml, ct);

        // 3. Receive audio chunks
        using var audioStream = new MemoryStream();
        var timestamps = new List<WordTimestamp>();
        var buffer = new byte[8192];
        // Reuse one MemoryStream across messages — `using var msgStream = new
        // MemoryStream()` inside the loop allocated a fresh stream per WS
        // message (one per ~8KB chunk = many per response), churning the GC
        // under load. SetLength(0) inside the loop resets without freeing the
        // backing buffer, so subsequent writes hit the same array.
        using var msgStream = new MemoryStream();

        try
        {
            while (ws.State == WebSocketState.Open)
            {
                msgStream.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(buffer, ct);
                    msgStream.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                if (result.MessageType == WebSocketMessageType.Binary)
                {
                    // Use GetBuffer() + length to avoid the ToArray() copy that
                    // each iteration would otherwise allocate.
                    var msgLen = (int)msgStream.Length;
                    var msgBuf = msgStream.GetBuffer();
                    if (msgLen > 2)
                    {
                        // First 2 bytes = header length (big-endian)
                        var headerLen = (msgBuf[0] << 8) | msgBuf[1];
                        var audioStart = headerLen + 2;
                        if (audioStart < msgLen)
                        {
                            var chunkLen = msgLen - audioStart;
                            // Hard cap — Bing should never exceed a few hundred KB for
                            // a 500-char input, so anything past maxAudioBytes is a
                            // protocol regression or attack. Bail before OOM.
                            if (audioStream.Length + chunkLen > maxAudioBytes)
                                throw new InvalidOperationException(
                                    $"TTS response exceeded {maxAudioBytes} bytes — aborting");
                            audioStream.Write(msgBuf, audioStart, chunkLen);
                        }
                    }
                }
                else if (result.MessageType == WebSocketMessageType.Text)
                {
                    var text_ = Encoding.UTF8.GetString(msgStream.GetBuffer(), 0, (int)msgStream.Length);
                    if (text_.Contains("Path:turn.end"))
                        break;
                    if (text_.Contains("Path:audio.metadata"))
                        ParseWordBoundaries(text_, timestamps);
                }
            }
        }
        finally
        {
            // Always attempt a graceful close. Without it, an exception path
            // (size cap, cancellation, IO error) leaves Bing seeing an abrupt
            // TCP RST when the `using ws` finalizes — repeated unfriendly
            // disconnects can attract rate-limiting / IP blocks. Best-effort:
            // socket may already be in a bad state, so swallow close failures.
            // Use a short bounded timeout — don't let close hang on a dead peer.
            if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
            {
                try
                {
                    using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, closeCts.Token);
                }
                catch { /* best-effort */ }
            }
        }

        return (audioStream.ToArray(), timestamps);
    }

    // Parses an Edge TTS text frame carrying Path:audio.metadata. Header and
    // JSON body are separated by \r\n\r\n (same wire format as the outgoing
    // config/ssml frames we send).
    //
    // Body JSON (observed): {"Metadata":[{"Type":"WordBoundary","Data":{
    //   "Offset":2000000,"Duration":500000,
    //   "text":{"Text":"hello","Length":5,"BoundaryType":"WordBoundary"}}}]}
    //
    // Offset/Duration are 100-ns ticks (1 ms = 10_000 ticks). They already
    // account for the "rate" parameter we sent, so client-side playback matches
    // timestamps directly — no post-scaling.
    //
    // Best-effort: any malformed body is silently skipped (empty timestamps
    // list is valid — caller should fall back to no-highlight playback).
    private static void ParseWordBoundaries(string text, List<WordTimestamp> output)
    {
        var bodyStart = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (bodyStart < 0) return;
        var body = text[(bodyStart + 4)..];
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("Metadata", out var meta) || meta.ValueKind != JsonValueKind.Array)
                return;
            foreach (var entry in meta.EnumerateArray())
            {
                if (!entry.TryGetProperty("Type", out var type) || type.GetString() != "WordBoundary")
                    continue;
                if (!entry.TryGetProperty("Data", out var data)) continue;
                if (!data.TryGetProperty("Offset", out var offsetEl) || !data.TryGetProperty("Duration", out var durationEl))
                    continue;
                if (!data.TryGetProperty("text", out var textEl) || !textEl.TryGetProperty("Text", out var wordEl))
                    continue;

                var offsetTicks = offsetEl.GetInt64();
                var durationTicks = durationEl.GetInt64();
                var word = wordEl.GetString();
                if (string.IsNullOrEmpty(word)) continue;

                output.Add(new WordTimestamp(
                    word,
                    offsetTicks / 10_000.0,
                    durationTicks / 10_000.0));
            }
        }
        catch (JsonException) { /* swallow — no highlighting is better than a broken synth */ }
    }

    public static async Task<List<EdgeVoiceData>> GetVoicesAsync(CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            // Headers per-request (not on SharedHttp.DefaultRequestHeaders) — shared
            // client is stateless; mutating defaults on a static client would race
            // across concurrent callers. Values = upstream VOICE_HEADERS.
            using var req = new HttpRequestMessage(HttpMethod.Get, VoiceListUrl + GecQuery());
            req.Headers.TryAddWithoutValidation("Authority", "speech.platform.bing.com");
            req.Headers.TryAddWithoutValidation("Sec-CH-UA", $"\" Not;A Brand\";v=\"99\", \"Microsoft Edge\";v=\"{Major}\", \"Chromium\";v=\"{Major}\"");
            req.Headers.TryAddWithoutValidation("Sec-CH-UA-Mobile", "?0");
            req.Headers.TryAddWithoutValidation("Accept", "*/*");
            req.Headers.TryAddWithoutValidation("Sec-Fetch-Site", "none");
            req.Headers.TryAddWithoutValidation("Sec-Fetch-Mode", "cors");
            req.Headers.TryAddWithoutValidation("Sec-Fetch-Dest", "empty");
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
            req.Headers.TryAddWithoutValidation("Cookie", $"muid={GenerateMuid()};");

            using var res = await SharedHttp.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
            if (attempt == 0 && res.StatusCode == System.Net.HttpStatusCode.Forbidden
                && EdgeTtsDrm.AdjustClockSkew(res.Headers.Date?.ToString("r")))
                continue;
            res.EnsureSuccessStatusCode();
            var json = await res.Content.ReadAsStringAsync(ct);
            return JsonSerializer.Deserialize<List<EdgeVoiceData>>(json) ?? [];
        }
    }

    private static async Task SendTextAsync(ClientWebSocket ws, string message, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(message);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    private static string ResolveXmlLang(string voice, string lang)
    {
        // Voice names follow "xx-YY-Name…" — first two dash-segments form the
        // BCP-47 tag. Fall back to caller-provided lang (or en-US) if the
        // voice name is malformed.
        var parts = voice.Split('-');
        if (parts.Length >= 2 && parts[0].Length == 2 && parts[1].Length >= 2)
            return $"{parts[0]}-{parts[1]}";
        if (!string.IsNullOrWhiteSpace(lang)) return lang.Contains('-') ? lang : $"{lang.ToLowerInvariant()}-{lang.ToUpperInvariant()}";
        return "en-US";
    }

    private static string GenerateMuid()
    {
        var bytes = new byte[16];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToHexString(bytes);
    }
}

public class EdgeVoiceData
{
    public string Name { get; set; } = "";
    public string ShortName { get; set; } = "";
    public string Gender { get; set; } = "";
    public string Locale { get; set; } = "";
    public string FriendlyName { get; set; } = "";
    public string Status { get; set; } = "";
    public string SuggestedCodec { get; set; } = "";
}
