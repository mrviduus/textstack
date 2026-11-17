using Microsoft.Extensions.Configuration;

namespace Infrastructure.Persistence;

/// <summary>The startup-only identity database selection. It never falls back after a V2 failure.</summary>
public sealed record DatabaseMode(bool IsV2)
{
    public const string ConfigurationKey = "Database:Mode";

    public static DatabaseMode Read(IConfiguration configuration)
    {
        var mode = configuration[ConfigurationKey];
        if (mode is null || string.Equals(mode, "legacy", StringComparison.OrdinalIgnoreCase)) return new(false);
        if (!string.Equals(mode, "v2", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Database:Mode must be legacy or v2.");
        if (!configuration.GetValue<bool>("Features:V2Api"))
            throw new InvalidOperationException("Database:Mode=v2 requires Features:V2Api=true.");
        if (string.IsNullOrWhiteSpace(configuration.GetConnectionString("V2")))
            throw new InvalidOperationException("Database:Mode=v2 requires ConnectionStrings:V2.");
        return new(true);
    }
}
