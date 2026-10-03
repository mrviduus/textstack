using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// Idempotent startup seeder for the <c>models</c> registry (AI-075). Seeds the
/// CURRENT primary routes (status=Primary) so the registry reflects what the gateway
/// serves today. Only inserts when the table is empty, so it's safe to run on every
/// boot and never fights admin edits. The migration itself stays data-free.
/// </summary>
public static class ModelRegistrySeeder
{
    // (feature, provider key, model id) for each current PRIMARY route. Mirrors
    // appsettings Ai:Routes + the per-provider model config.
    private static readonly (string Feature, string Provider, string Model)[] Primaries =
    [
        ("explain", "openai-explain", "gpt-4.1-nano"),
        ("explain.toolcall", "openai-explain", "gpt-4.1-nano"),
        ("translate", "openai", "gpt-4.1-nano"),
        ("distractor", "ollama", "gemma4:e2b"),
        ("bookmeta", "ollama", "gemma4:e2b"),
        ("tagsuggestion", "ollama", "gemma4:e2b"),
        ("podcast.script", "openai", "gpt-4.1-nano"),
    ];

    public static async Task SeedAsync(AppDbContext db, CancellationToken ct = default)
    {
        if (await db.Models.AnyAsync(ct))
            return;

        var now = DateTimeOffset.UtcNow;
        db.Models.AddRange(Primaries.Select(p => new ModelRegistration
        {
            Id = Guid.NewGuid(),
            FeatureTag = p.Feature,
            ProviderKey = p.Provider,
            ModelId = p.Model,
            Status = ModelStatus.Primary,
            CreatedAt = now,
        }));
        await db.SaveChangesAsync(ct);
    }
}
