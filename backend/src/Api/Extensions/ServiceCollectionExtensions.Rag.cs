using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TextStack.Ai.Rag;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// RAG stack: vector retrieval, on-demand chunking, and the spoiler-safe
    /// context + "Ask this book" orchestration services (public + user-book).
    /// </summary>
    public static IServiceCollection AddTextStackRag(this IServiceCollection services, string connectionString)
    {
        // RAG vector retrieval (Phase 4). Raw Npgsql like the search provider; query embedded via
        // IEmbeddingService (registered in AddApplication). Used by the admin debug endpoint (AI-022).
        services.AddRagRetrieval(_ => () => new NpgsqlConnection(connectionString));
        // On-demand "Ask this book" index trigger (Phase 1): the chunker + shared chunking service.
        services.AddAiRag();
        // ADR-012 S3: vision PDF→Markdown parser (renders pages + calls the pdf.parse LLM route).
        // Singleton — its deps (storage, LLM gateway) are singletons; safe under the scoped chunker too.
        services.AddSingleton<Application.Rag.IPdfVisionParser, Infrastructure.Rag.PdfVisionParser>();
        // Per-chapter summary generator ("S2"): nano route via FeatureTag "rag.summarize". Injected into
        // the chunking service so an indexing run also emits one whole-chapter summary chunk per chapter.
        services.AddScoped<Application.Rag.ChapterSummarizer>();
        services.AddScoped<Infrastructure.Rag.BookChunkingService>();
        // Spoiler-safe context builder (AI-024): resolves lastRead + gates chunks + private corpus.
        services.AddScoped<Application.Rag.RagContextService>();
        // "Ask this book" orchestration (AI-025): context + LLM gateway → grounded answer with citations.
        services.AddScoped<Application.Rag.RagAskService>();
        services.AddScoped<Application.Rag.IRagAskService>(sp => sp.GetRequiredService<Application.Rag.RagAskService>());
        // Phase 2 "Ask this book" for user uploads: per-user isolated retrieval context (no spoiler gate).
        services.AddScoped<Application.Rag.UserBookRagContextService>();
        // Persistent Book Chat rolling-summary generator (nano route via FeatureTag "explain").

        return services;
    }
}
