using Microsoft.Extensions.DependencyInjection;

namespace TextStack.Vocabulary;

public static class DependencyInjection
{
    public static IServiceCollection AddTextStackVocabulary(this IServiceCollection services) =>
        services.AddSingleton<ISrsEngine, SrsEngine>();
}
