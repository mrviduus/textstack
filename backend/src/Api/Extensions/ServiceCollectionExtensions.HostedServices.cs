using Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Extensions;

public static partial class ServiceCollectionExtensions
{
    /// <summary>
    /// Background workers. Registration order is preserved from Program.cs — IHostedService
    /// is resolved as an ordered enumerable, so startup order matches the original.
    /// NOTE: the EdgeTts startup-cleanup hosted service is registered in
    /// <see cref="AddTextStackContentServices"/> (before this call in Program.cs), keeping it
    /// first in the sequence exactly as before.
    /// </summary>
    public static IServiceCollection AddTextStackHostedServices(this IServiceCollection services)
    {
        // SSG periodic rebuild
        services.AddHostedService<SsgPeriodicRebuildWorker>();

        // Vocabulary anti-spiral: periodic auto-retire sweep (F4)
        services.AddHostedService<AutoRetireSweeperWorker>();

        // Vocabulary anti-spiral: daily-cap pending → SRS reconciler (F2)
        services.AddHostedService<DailyCapReconcilerWorker>();

        // Vocabulary anti-spiral: one-shot seed of word_frequencies from embedded gz (F1)
        services.AddHostedService<WordFrequencyLoaderWorker>();

        // Vocabulary anti-spiral: 24h cluster candidate builder (F3)
        services.AddHostedService<ClusterCandidateBuilderWorker>();

        // AI-058: weekly semantic concept clustering (groups vocab by meaning across all books)
        services.AddHostedService<ConceptClusteringWorker>();
        // Phase 12 RLOps slice 5a: scheduled continuous evals (OFF by default — Eval:Scheduled:Enabled).
        services.AddHostedService<ContinuousEvalWorker>();
        // Phase 12 RLOps slice 5b: embedding-drift detection (OFF by default — Drift:Enabled).
        services.AddHostedService<DriftDetectionWorker>();

        return services;
    }
}
