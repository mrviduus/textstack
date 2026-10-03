using Microsoft.Extensions.DependencyInjection;

namespace TextStack.Vocabulary;

public static class DependencyInjection
{
    public static IServiceCollection AddTextStackVocabulary(
        this IServiceCollection services,
        Action<VocabularyOptions>? configure = null)
    {
        if (configure != null)
            services.Configure(configure);

        services.AddSingleton<ISrsEngine, SrsEngine>();
        services.AddSingleton<IReviewCardBuilder, ReviewCardBuilder>();
        services.AddScoped<IDistractorGenerator, DistractorGenerator>();
        services.AddScoped<IClusterBuilder, ClusterBuilder>();

        return services;
    }
}
