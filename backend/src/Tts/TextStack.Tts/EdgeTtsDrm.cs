using System.Buffers.Binary;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace TextStack.Tts;

/// <summary>
/// Sec-MS-GEC v2 token + clock-skew correction for the Edge TTS endpoints.
/// Straight port of rany2/edge-tts <c>drm.py</c> (generate_sec_ms_gec_v2, DRM class).
/// The "SHA-256" below is SHA-256 over a hidden 57-byte prefix, resumed from a
/// precomputed state; constants are upstream's verbatim. Unit tests pin it to
/// upstream outputs (EdgeTtsDrmTests) — re-run them if upstream bumps constants.
/// </summary>
internal static class EdgeTtsDrm
{
    public const string TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    public const string ChromiumFullVersion = "143.0.3650.75";
    public const string ChromiumMajorVersion = "143";
    public const string SecMsGecVersion = "2-" + ChromiumFullVersion;

    private const long WinEpoch = 11_644_473_600L;

    private static readonly Lock SkewLock = new();
    private static double _clockSkewSeconds;

    /// <summary>Current Unix time in seconds, corrected by the learned clock skew.</summary>
    public static double UnixNow()
    {
        lock (SkewLock)
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0 + _clockSkewSeconds;
    }

    /// <summary>
    /// Upstream DRM.handle_client_response_error: on a 403, shift our clock by
    /// (server Date − our clock). Returns false when the Date header is missing
    /// or unparsable (upstream raises SkewAdjustmentError; caller then gives up).
    /// </summary>
    public static bool AdjustClockSkew(string? serverDate)
    {
        lock (SkewLock)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0 + _clockSkewSeconds;
            var skew = SkewFromServerDate(serverDate, DateTimeOffset.FromUnixTimeMilliseconds((long)(now * 1000)));
            if (skew is null) return false;
            _clockSkewSeconds += skew.Value;
            return true;
        }
    }

    internal static double? SkewFromServerDate(string? serverDate, DateTimeOffset clientNow)
    {
        if (string.IsNullOrWhiteSpace(serverDate)) return null;
        if (!DateTimeOffset.TryParse(serverDate, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var parsed))
            return null;
        return (parsed - clientNow).TotalSeconds;
    }

    public static string GenerateSecMsGec() => GenerateSecMsGec((long)Math.Floor(UnixNow()));

    /// <summary>generate_sec_ms_gec_v2: "&lt;CS64 16 hex&gt;-&lt;SHA256 64 hex&gt;".</summary>
    public static string GenerateSecMsGec(long unixSeconds)
    {
        var ticks = unixSeconds + WinEpoch;
        ticks -= ticks % 300;
        ticks *= 10_000_000; // 100-ns Windows file-time units
        var data = Encoding.ASCII.GetBytes($"{ticks}{TrustedClientToken}");
        var digest = Sha256Digest(data);
        var (cs0, cs1) = Cs64Digest(data, digest);
        var cs = new byte[8];
        BinaryPrimitives.WriteUInt32LittleEndian(cs, cs0);
        BinaryPrimitives.WriteUInt32LittleEndian(cs.AsSpan(4), cs1);
        return $"{Convert.ToHexString(cs)}-{Convert.ToHexString(digest)}";
    }

    // ---- SHA-256 with hidden prefix (drm.py _sha256_*) ----

    private static readonly uint[] Sha256Initial =
        [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];

    private static readonly uint[] Sha256State =
        [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];

    private static readonly uint[] Sha256Schedule =
    [
        0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
        0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
    ];

    private static readonly uint[] Sha256RoundConstants =
    [
        0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
        0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
        0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
        0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
        0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
        0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
        0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
        0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
    ];

    private const uint Sha256Adjustment = 0xC9DC06A7;
    private const uint Sha256Sigma0Adjustment = 0x059C0B80;
    private const uint Sha256Sigma1Adjustment = 0x000B92C0;

    private static readonly uint[] Sha256BlockConstants = BuildBlockConstants();

    private static uint[] BuildBlockConstants()
    {
        var k = (uint[])Sha256RoundConstants.Clone();
        k[14] = Sha256Adjustment;
        return k;
    }

    private static uint Sigma0(uint v) => BitOperations.RotateRight(v, 7) ^ BitOperations.RotateRight(v, 18) ^ (v >> 3);
    private static uint Sigma1(uint v) => BitOperations.RotateRight(v, 17) ^ BitOperations.RotateRight(v, 19) ^ (v >> 10);

    private static void ExpandSchedule(uint[] w, int firstWord = 16)
    {
        for (var i = firstWord; i < 64; i++)
            w[i] = Sigma1(w[i - 2]) + w[i - 7] + Sigma0(w[i - 15]) + w[i - 16];
    }

    // Standard SHA-256 compression rounds, optionally resuming at firstRound
    // (upstream unrolls the loop; the arithmetic is the same mod 2^32).
    private static uint[] Rounds(uint[] state, uint[] w, int firstRound = 0)
    {
        var k = firstRound == 14 ? Sha256BlockConstants : Sha256RoundConstants;
        uint a = state[0], b = state[1], c = state[2], d = state[3],
             e = state[4], f = state[5], g = state[6], h = state[7];
        for (var i = firstRound; i < 64; i++)
        {
            var s1 = BitOperations.RotateRight(e, 6) ^ BitOperations.RotateRight(e, 11) ^ BitOperations.RotateRight(e, 25);
            var t1 = h + s1 + (g ^ (e & (f ^ g))) + k[i] + w[i];
            var s0 = BitOperations.RotateRight(a, 2) ^ BitOperations.RotateRight(a, 13) ^ BitOperations.RotateRight(a, 22);
            var t2 = s0 + ((a & b) | (c & (a | b)));
            h = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }
        return [a, b, c, d, e, f, g, h];
    }

    private static uint[] Sha256Init(ReadOnlySpan<byte> data7)
    {
        var w = new uint[64];
        w[14] = (uint)(data7[0] << 16 | data7[1] << 8 | data7[2]);
        w[15] = BinaryPrimitives.ReadUInt32BigEndian(data7[3..7]);
        for (var i = 16; i < 30; i++)
        {
            var value = Sha256Schedule[i - 16];
            if (i - 2 >= 14)
                value += i == 16 ? Sigma1(w[i - 2]) ^ Sha256Sigma1Adjustment : Sigma1(w[i - 2]);
            if (i - 7 >= 14)
                value += w[i - 7];
            if (i - 15 >= 14)
                value += i == 29 ? Sigma0(w[i - 15]) ^ Sha256Sigma0Adjustment : Sigma0(w[i - 15]);
            w[i] = value;
        }
        w[30] = Sigma1(w[28]) + w[23] + Sigma0(w[15]) + w[14] + Sha256Adjustment - Sha256RoundConstants[14];
        ExpandSchedule(w, 31);
        var working = Rounds(Sha256State, w, 14);
        var result = new uint[8];
        for (var i = 0; i < 8; i++) result[i] = Sha256Initial[i] + working[i];
        return result;
    }

    private static byte[] Sha256Digest(byte[] data)
    {
        if (data.Length < 7) throw new ArgumentException("Token salt must contain at least seven bytes");
        var length = 57 + data.Length;
        var zeros = ((55 - length) % 64 + 64) % 64;
        var padded = new byte[data.Length - 7 + 1 + zeros + 8];
        data.AsSpan(7).CopyTo(padded);
        padded[data.Length - 7] = 0x80;
        BinaryPrimitives.WriteUInt64BigEndian(padded.AsSpan(padded.Length - 8), (ulong)length * 8);

        var state = Sha256Init(data.AsSpan(0, 7));
        for (var offset = 0; offset < padded.Length; offset += 64)
        {
            var w = new uint[64];
            for (var i = 0; i < 16; i++)
                w[i] = BinaryPrimitives.ReadUInt32BigEndian(padded.AsSpan(offset + i * 4, 4));
            ExpandSchedule(w);
            var working = Rounds(state, w);
            for (var i = 0; i < 8; i++) state[i] += working[i];
        }
        var digest = new byte[32];
        for (var i = 0; i < 8; i++) BinaryPrimitives.WriteUInt32BigEndian(digest.AsSpan(i * 4), state[i]);
        return digest;
    }

    // ---- CS64 (drm.py _cs64_digest) ----

    private static readonly (uint Coefficient, uint Offset)[] Cs64Coefficients =
    [
        (0xE82E91B1, 0xB32700D0), (0x44DE24C6, 0x88DFF51D), (0x3BEB65BC, 0x29514038),
        (0xC89C5933, 0xB328CBDF), (0x8D1EC211, 0xD405B4D5), (0x314EF5D5, 0x26E55F3C),
        (0xE92491B1, 0x607801C6), (0xF0A5B9D5, 0x82B2C1FB), (0x06064CF3, 0xFA51A3DA),
        (0xDA79FA60, 0x207CC464), (0xBED20560, 0x3C3C74F3), (0x89F9C9F8, 0xD2D14B61),
        (0x35FA38C6, 0xBB04A2C1), (0xCB49E3C6, 0xC5626167),
    ];

    private const uint Cs64Factor = 0x82893933;
    private const uint Cs64Adjustment0 = 0xF2F90B1A;
    private const uint Cs64Adjustment1 = 0x0B1A0000;

    private static uint Rol16(uint v) => BitOperations.RotateLeft(v, 16);

    // Little-endian 32-bit words, zero-padded to an even word count.
    private static List<uint> WordsLe4Even(byte[] data)
    {
        var padded = new byte[(data.Length + 3) / 4 * 4];
        data.CopyTo(padded, 0);
        var words = new List<uint>(padded.Length / 4 + 1);
        for (var i = 0; i < padded.Length; i += 4)
            words.Add(BinaryPrimitives.ReadUInt32LittleEndian(padded.AsSpan(i, 4)));
        if (words.Count % 2 == 1) words.Add(0);
        return words;
    }

    private static (uint, uint) Cs64Digest(byte[] data, byte[] digest)
    {
        var keyA = BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(0, 4)) | 1;
        var keyB = BinaryPrimitives.ReadUInt32LittleEndian(digest.AsSpan(4, 4)) | 1;
        uint[] factors = [keyA * Cs64Factor, keyB * Cs64Factor];

        var terms = new List<uint>();
        var offsets = new List<uint>();
        for (var i = 0; i < Cs64Coefficients.Length; i++)
        {
            terms.Add(Cs64Coefficients[i].Coefficient * factors[i % 2]);
            offsets.Add(Cs64Coefficients[i].Offset);
        }

        var prefixed = new byte[data.Length + 1];
        data.CopyTo(prefixed, 1);
        var words = WordsLe4Even(prefixed);
        for (var i = 0; i < words.Count; i++)
        {
            var word = words[i];
            var term = word * (i % 2 == 0 ? keyA : keyB);
            var offset = Rol16(word) * (i % 2 == 0 ? 0xEF0569FBu : 0xC31713DBu);
            if (i == 0)
            {
                term += Cs64Adjustment0 * factors[0];
                offset += Cs64Adjustment1;
            }
            terms.Add(term);
            offsets.Add(offset);
        }

        uint swapAcc = 0, swapLast = 0, state = 0, acc = 0;
        for (var i = 0; i < terms.Count; i += 2)
        {
            uint x = terms[i], y = terms[i + 1];
            var t = Rol16(offsets[i] + x);
            var q = t * 0x76F50F34u;
            swapAcc += Rol16(q) * 0xC3EFEA97u + q;
            t = Rol16(offsets[i + 1] + y);
            q = t * 0x1881CE3Cu;
            swapLast = Rol16(q) * 0x35BD1EC9u + q;
            swapAcc += swapLast;

            state = state * keyA + x;
            state = Rol16(state) * 0xCF98B111u;
            state = Rol16(state) * 0x87085B9Fu;
            state = Rol16(state) * 0x12CEB96Du;
            state = Rol16(state) * 0x257E1D83u;
            acc += state;
            t = state * keyB + y;
            t = Rol16(t) * 0xA27416F5u;
            t = Rol16(t) * 0xD38396FFu;
            state = Rol16(Rol16(t) * 0x7C932B89u) * 0xBFA49F69u;
            acc += state;
        }
        return (swapLast ^ state, swapAcc ^ acc);
    }
}
