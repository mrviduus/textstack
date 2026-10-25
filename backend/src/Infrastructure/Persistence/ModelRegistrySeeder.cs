using Domain.Entities;
using Domain.Enums;
using TextStack.Ai.Llm;
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
    // appsettings Ai:Routes + the configured OpenAI models, so the registry names what is served.
    private static (string Feature, string Provider, string Model)[] Primaries(OpenAiOptions openAi) =>
    [
        ("explain", "openai-explain", openAi.Explain.Model),
        ("explain.toolcall", "openai-explain", openAi.Explain.Model),
        ("translate", "openai", openAi.Model),
        ("distractor", "ollama", "gemma4:e2b"),
        ("bookmeta", "ollama", "gemma4:e2b"),
        ("tagsuggestion", "ollama", "gemma4:e2b"),
    ];

    public static async Task SeedAsync(AppDbContext db, OpenAiOptions openAi, CancellationToken ct = default)
    {
        if (await db.Models.AnyAsync(ct))
            return;

        var now = DateTimeOffset.UtcNow;
        db.Models.AddRange(Primaries(openAi).Select(p => new ModelRegistration
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
