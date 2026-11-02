using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Application.Common;

/// <summary>
/// <c>payload_sha256</c> of a replayable append (v2-sync-protocol.md "Canonical JSON"): the one
/// function the API and the M3 ETL both hash through, so they cannot disagree. Serialization is RFC
/// 8785 (JSON Canonicalization Scheme) in full; on top of it the PDD's rules: camelCase wire names,
/// a null field omitted (null and absent hash equal), UUIDs lowercase, times UTC with milliseconds,
/// truncated. The caller passes the normalized value as stored, with only the fields the PDD lists.
/// </summary>
public static class CanonicalPayload
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web) { Converters = { new UtcMillisecondsConverter() } };

    /// <summary>Lowercase hex SHA-256 of the canonical UTF-8 bytes of <paramref name="payload"/>, a JSON object.</summary>
    public static string Sha256(object payload)
    {
        if (JsonSerializer.SerializeToNode(payload, payload.GetType(), Wire) is not JsonObject fields)
            throw new ArgumentException("A payload is a JSON object.", nameof(payload));
        foreach (var absent in fields.Where(f => f.Value is null).Select(f => f.Key).ToList())
            fields.Remove(absent);
        // RFC 8785 makes a lone surrogate an error; System.Text.Json has already replaced it with U+FFFD here.
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonicalize(fields))));
    }

    /// <summary>RFC 8785 alone: members sorted by UTF-16 code units at every depth, no whitespace, minimal escaping, ES6 numbers.</summary>
    public static string Canonicalize(JsonNode? node)
    {
        var json = new StringBuilder();
        Write(json, node);
        return json.ToString();
    }

    private static void Write(StringBuilder json, JsonNode? node)
    {
        switch (node)
        {
            case null:
                json.Append("null");
                break;
            case JsonObject members:
                json.Append('{');
                var first = true;
                // Ordinal string comparison is by UTF-16 code unit, which is what §3.2.3 sorts by.
                foreach (var (name, member) in members.OrderBy(m => m.Key, StringComparer.Ordinal))
                {
                    if (!first) json.Append(',');
                    first = false;
                    WriteString(json, name);
                    json.Append(':');
                    Write(json, member);
                }
                json.Append('}');
                break;
            case JsonArray items:
                json.Append('[');
                for (var i = 0; i < items.Count; i++)
                {
                    if (i > 0) json.Append(',');
                    Write(json, items[i]);
                }
                json.Append(']');
                break;
            default:
                var value = node.AsValue();
                switch (value.GetValueKind())
                {
                    case JsonValueKind.String: WriteString(json, value.GetValue<string>()); break;
                    case JsonValueKind.Number: json.Append(Es6Number(value.GetValue<double>())); break;
                    case JsonValueKind.True: json.Append("true"); break;
                    case JsonValueKind.False: json.Append("false"); break;
                    default: json.Append("null"); break;
                }
                break;
        }
    }

    // §3.2.2.2: only the quote, the backslash and the C0 controls are escaped; the five with a short
    // form use it, the rest \u00xx in lowercase hex. Everything else is written as itself.
    private static void WriteString(StringBuilder json, string text)
    {
        json.Append('"');
        foreach (var c in text)
        {
            switch (c)
            {
                case '"': json.Append("\\\""); break;
                case '\\': json.Append("\\\\"); break;
                case '\b': json.Append("\\b"); break;
                case '\f': json.Append("\\f"); break;
                case '\n': json.Append("\\n"); break;
                case '\r': json.Append("\\r"); break;
                case '\t': json.Append("\\t"); break;
                case < ' ': json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture)); break;
                default: json.Append(c); break;
            }
        }
        json.Append('"');
    }

    /// <summary>
    /// ECMAScript's Number.prototype.toString (§3.2.2.3): the shortest digits that round-trip, which
    /// .NET's "R" also gives, laid out by ES6's rules for where the point and the exponent go.
    /// </summary>
    private static string Es6Number(double number)
    {
        if (!double.IsFinite(number))
            throw new ArgumentException("JSON has no NaN or Infinity (RFC 8785 §3.2.2.3).", nameof(number));
        if (number == 0) return "0"; // -0 too
        var roundTrip = Math.Abs(number).ToString("R", CultureInfo.InvariantCulture); // "123.45", "1E-07", "1.5E+300"
        var e = roundTrip.IndexOf('E');
        var mantissa = e < 0 ? roundTrip : roundTrip[..e];
        var dot = mantissa.IndexOf('.');
        var allDigits = mantissa.Replace(".", "", StringComparison.Ordinal);
        var digits = allDigits.TrimStart('0');
        // n: where the decimal point sits relative to the first significant digit (ES6's n); k: the digit count.
        var n = (dot < 0 ? mantissa.Length : dot) + (e < 0 ? 0 : int.Parse(roundTrip[(e + 1)..], CultureInfo.InvariantCulture))
                - (allDigits.Length - digits.Length);
        digits = digits.TrimEnd('0');
        var k = digits.Length;
        var text = k <= n && n <= 21 ? digits + new string('0', n - k)
            : 0 < n && n <= 21 ? digits[..n] + "." + digits[n..]
            : -6 < n && n <= 0 ? "0." + new string('0', -n) + digits
            : digits[..1] + (k > 1 ? "." + digits[1..] : "") + "e" + (n - 1 < 0 ? "-" : "+") + Math.Abs(n - 1).ToString(CultureInfo.InvariantCulture);
        return number < 0 ? "-" + text : text;
    }

    /// <summary>"…+02:00" and "…Z" for one instant hash equal: UTC, milliseconds, truncated.</summary>
    private sealed class UtcMillisecondsConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException("Canonical JSON is written, never read.");

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
            writer.WriteStringValue(value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
    }
}
