using System.Text.Json;
using Application.Tools;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-030 starter tools — the parts testable without a DB/network: discovery via the assembly scan,
/// schema validity (each tool's ArgsSchema accepts its happy path and rejects malformed args through
/// the same validator the dispatcher uses).
/// </summary>
public class StarterToolsTests
{
    private static readonly string[] ExpectedNames =
        ["get_chapter", "get_user_highlights"];

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void AddAiTools_ScanningApplication_DiscoversTheStarterTools()
    {
        var services = new ServiceCollection();
        services.AddAiTools(typeof(GetChapterTool).Assembly);

        using var sp = services.BuildServiceProvider();
        var registry = sp.GetRequiredService<IToolRegistry>();

        foreach (var name in ExpectedNames)
            Assert.NotNull(registry.Get(name));

    }

    [Theory]
    [InlineData(typeof(GetChapterTool), """{"chapter_number": 3}""", """{"chapter_number": 0}""")]
    [InlineData(typeof(GetUserHighlightsTool), """{"query": "lsm", "limit": 5}""", """{"limit": 99}""")]
    public void ArgsSchema_AcceptsHappyPath_RejectsMalformed(Type toolType, string goodArgs, string badArgs)
    {
        var tool = (ITool)Activator.CreateInstance(toolType)!;

        Assert.Null(ToolDispatcher.ValidateArgs(tool.ArgsSchema, Args(goodArgs)));
        Assert.NotNull(ToolDispatcher.ValidateArgs(tool.ArgsSchema, Args(badArgs)));
    }

    [Theory]
    [InlineData(typeof(GetChapterTool))]
    [InlineData(typeof(GetUserHighlightsTool))]
    public void ArgsSchema_RejectsUnknownProperties(Type toolType)
    {
        var tool = (ITool)Activator.CreateInstance(toolType)!;
        Assert.NotNull(ToolDispatcher.ValidateArgs(tool.ArgsSchema, Args("""{"hallucinated_arg": true}""")));
    }
}
