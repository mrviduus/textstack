using System.Text.Json;

namespace TextStack.Ai.Mcp.Tools;

/// <summary>
/// Manual argument reader for tool handlers. The low-level MCP handler path does
/// NOT validate calls against a tool's <c>InputSchema</c>, so each handler must
/// re-enforce the same constraints. This keeps every tool's validator ~15 lines
/// and consistent: object shape, <c>additionalProperties:false</c>, required
/// strings/guids, and bounded optional ints.
///
/// An optional argument sent as JSON <c>null</c> reads as absent: hosts send nulls for what they leave out.
///
/// Every method returns false (with a model-facing <paramref name="error"/>) on
/// violation; on success the out value is set. Validators never throw.
/// </summary>
internal static class ArgReader
{
    /// <summary>
    /// Confirms the args are a JSON object and contain no properties outside
    /// <paramref name="allowed"/> (mirrors <c>additionalProperties:false</c>).
    /// </summary>
    public static bool TryObject(
        JsonElement? args,
        out JsonElement obj,
        out string error,
        params string[] allowed)
    {
        error = "";
        if (args is not { ValueKind: JsonValueKind.Object } o)
        {
            obj = default;
            error = "Arguments must be an object.";
            return false;
        }

        foreach (var prop in o.EnumerateObject())
        {
            if (Array.IndexOf(allowed, prop.Name) < 0)
            {
                obj = default;
                error = $"Unknown argument '{prop.Name}'.";
                return false;
            }
        }

        obj = o;
        return true;
    }

    /// <summary>Required non-empty string, length within [min, max].</summary>
    public static bool TryRequiredString(
        JsonElement obj, string name, int min, int max, out string value, out string error)
    {
        value = "";
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.String)
        {
            error = $"'{name}' is required and must be a string.";
            return false;
        }

        var s = el.GetString() ?? "";
        if (s.Length < min || s.Length > max)
        {
            error = $"'{name}' must be between {min} and {max} characters.";
            return false;
        }

        value = s;
        return true;
    }

    /// <summary>Required GUID (string parsed via <see cref="Guid.TryParse(string, out Guid)"/>).</summary>
    public static bool TryRequiredGuid(
        JsonElement obj, string name, out Guid value, out string error)
    {
        value = Guid.Empty;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.String
            || !Guid.TryParse(el.GetString(), out var g))
        {
            error = $"'{name}' is required and must be a UUID.";
            return false;
        }

        value = g;
        return true;
    }

    /// <summary>
    /// Optional integer within [min, max]. Absent → <paramref name="value"/> stays
    /// null (true). Present-but-invalid (wrong type, non-integer, out of range,
    /// Int32 overflow) → false.
    /// </summary>
    public static bool TryOptionalInt(
        JsonElement obj, string name, int min, int max, out int? value, out string error)
    {
        value = null;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            return true;

        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out var i))
        {
            error = $"'{name}' must be an integer.";
            return false;
        }

        if (i < min || i > max)
        {
            error = $"'{name}' must be between {min} and {max}.";
            return false;
        }

        value = i;
        return true;
    }

    /// <summary>
    /// Optional GUID. Absent → <paramref name="value"/> stays null (true); present-but-unparseable
    /// → false. Used where a tool takes one of two mutually exclusive identifiers and has to check
    /// the exclusivity itself, which JSON Schema cannot express in a form the SDK enforces anyway.
    /// </summary>
    public static bool TryOptionalGuid(
        JsonElement obj, string name, out Guid? value, out string error)
    {
        value = null;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            return true;

        if (el.ValueKind != JsonValueKind.String || !Guid.TryParse(el.GetString(), out var g))
        {
            error = $"'{name}' must be a UUID.";
            return false;
        }

        value = g;
        return true;
    }

    /// <summary>Optional string with a max length. Absent → null (true).</summary>
    public static bool TryOptionalString(
        JsonElement obj, string name, int max, out string? value, out string error)
    {
        value = null;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            return true;

        if (el.ValueKind != JsonValueKind.String)
        {
            error = $"'{name}' must be a string.";
            return false;
        }

        var s = el.GetString() ?? "";
        if (s.Length > max)
        {
            error = $"'{name}' must be at most {max} characters.";
            return false;
        }

        value = s;
        return true;
    }

    /// <summary>Optional JSON array of anything (opaque to the bridge). Absent or null → null (true).</summary>
    public static bool TryOptionalArray(JsonElement obj, string name, out JsonElement? value, out string error)
    {
        value = null;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            return true;

        if (el.ValueKind != JsonValueKind.Array)
        {
            error = $"'{name}' must be an array.";
            return false;
        }

        value = el;
        return true;
    }

    /// <summary>
    /// Optional array of at most <paramref name="maxItems"/> non-blank strings (the schema's
    /// <c>maxItems</c> and <c>items.minLength</c>), order kept. Absent or null → empty (true).
    /// </summary>
    public static bool TryOptionalStringArray(
        JsonElement obj, string name, int maxItems, out string[] value, out string error)
    {
        value = [];
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            return true;

        if (el.ValueKind != JsonValueKind.Array || el.GetArrayLength() > maxItems)
        {
            error = $"'{name}' must be an array of at most {maxItems} strings.";
            return false;
        }

        var items = new string[el.GetArrayLength()];
        var i = 0;
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                error = $"'{name}' must be an array of at most {maxItems} strings.";
                return false;
            }
            if (string.IsNullOrWhiteSpace(items[i] = item.GetString()!))
            {
                error = $"'{name}[{i}]' must not be blank.";
                return false;
            }
            i++;
        }

        value = items;
        return true;
    }
}
