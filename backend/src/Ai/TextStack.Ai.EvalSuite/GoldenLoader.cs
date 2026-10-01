using System.Reflection;
using System.Text.Json;

namespace TextStack.Ai.EvalSuite;

/// <summary>Loads a golden dataset from the assembly's embedded <c>Datasets/*.json</c>
/// so the same goldens ship to the API (admin "Run evals") and the test suite.</summary>
internal static class GoldenLoader
{
    private static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };

    public static IReadOnlyList<T> Load<T>(string fileName)
    {
        using var stream = OpenResource("Datasets." + fileName);
        return JsonSerializer.Deserialize<List<T>>(stream, Opts)
            ?? throw new InvalidOperationException($"{fileName} deserialized to null");
    }

    private static Stream OpenResource(string suffix)
    {
        var asm = typeof(GoldenLoader).Assembly;
        var resource = asm.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith(suffix, StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"Embedded resource not found: {suffix}");
        return asm.GetManifestResourceStream(resource)!;
    }
}
