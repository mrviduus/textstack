using TextStack.Extraction.TextProcessing.Abstractions;
using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.TextProcessing.Processors;

namespace TextStack.Extraction.TextProcessing.Pipeline;

/// <summary>
/// Builder for creating text processing pipeline.
/// </summary>
public class PipelineBuilder
{
    private readonly List<ITextProcessor> _processors = [];

    /// <summary>
    /// Add processor.
    /// </summary>
    public PipelineBuilder Add(ITextProcessor processor)
    {
        _processors.Add(processor);
        return this;
    }

    /// <summary>
    /// Add processor if condition is true.
    /// </summary>
    public PipelineBuilder AddIf(bool condition, ITextProcessor processor)
    {
        if (condition) Add(processor);
        return this;
    }

    /// <summary>
    /// Build pipeline.
    /// </summary>
    public IProcessingPipeline Build()
        => new ProcessingPipeline(_processors);

    /// <summary>
    /// Create default pipeline.
    /// </summary>
    public static PipelineBuilder CreateDefault(TextProcessingOptions? options = null)
    {
        options ??= new();
        return new PipelineBuilder()
            .Add(new WhitespaceProcessor())
            .Add(new EntityProcessor())
            .Add(new EmptyTagProcessor())
            .AddIf(options.EnableSpelling, new SpellingProcessor())
            .AddIf(options.EnableSpelling, new HyphenationProcessor())
            .AddIf(options.EnableTypography, new TypographyProcessor())
            .AddIf(options.EnableSemantic, new SemanticProcessor());
    }
}
