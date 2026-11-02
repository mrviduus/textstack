using System.Text.Json;
using System.Text.Json.Serialization;

namespace Contracts.V2;

/// <summary>
/// Opaque client JSON (locators, toc) carried as its raw text: written into the response as is, read
/// from a request as its text, so a jsonb value is never parsed into a tree only to be serialised again.
/// </summary>
public sealed class RawJsonConverter : JsonConverter<string>
{
    public override string Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var value = JsonDocument.ParseValue(ref reader);
        return value.RootElement.GetRawText();
    }

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) => writer.WriteRawValue(value, skipInputValidation: true); // jsonb text: valid by construction
}
