using System.Reflection;
using System.Runtime.CompilerServices;
using Application.Agents;
using Application.Tools;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// Every tool an agent is allowed to call must actually exist.
///
/// <para>This exists because the Tutor spent months instructing the model to call
/// <c>get_example_sentence</c> after that tool was deleted with the retrieval spine.
/// <c>ToolRegistry.SchemasFor</c> skips a name it does not recognise <b>silently</b> — by design, so a
/// half-configured agent still runs — so nothing failed, nothing logged, and the model was simply
/// never offered a tool its own system prompt ordered it to use. Every run paid for the instruction
/// and could only be degraded by it.</para>
///
/// <para>The names are read off the concrete <see cref="ITool"/> types rather than from a DI container:
/// tool <c>Name</c>s are literals on stateless singletons, so an uninitialised instance answers the
/// question without needing a database, an LLM client, or the API's whole composition root. If a tool
/// ever computes its name from injected state this will throw rather than lie — which is the right
/// failure, and the assertion message says so.</para>
/// </summary>
public class AgentAllowedToolsExistTests
{
    private static HashSet<string> RegisteredToolNames()
    {
        var assembly = typeof(GetChapterTool).Assembly;
        var names = new HashSet<string>(StringComparer.Ordinal);

        foreach (var type in assembly.GetTypes())
        {
            if (type is not { IsAbstract: false, IsInterface: false, IsGenericTypeDefinition: false }) continue;
            if (!typeof(ITool).IsAssignableFrom(type)) continue;

            var instance = (ITool)RuntimeHelpers.GetUninitializedObject(type);
            names.Add(instance.Name);
        }

        Assert.True(names.Count > 5, $"tool discovery found only {names.Count} tools — the scan is broken, not the agents");
        return names;
    }

    /// <summary>Every `AllowedTools` list on an agent, found by reflection so a new agent is covered
    /// the day it is written rather than the day someone remembers this test.</summary>
    public static TheoryData<string, string[]> AgentToolLists()
    {
        var data = new TheoryData<string, string[]>();
        var agents = typeof(TutorAgent).Assembly.GetTypes()
            .Where(t => t.Namespace == "Application.Agents" && !t.IsAbstract);

        foreach (var agent in agents)
        {
            var field = agent.GetField("AllTools", BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Public);
            if (field?.GetValue(null) is string[] tools && tools.Length > 0)
                data.Add(agent.Name, tools);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(AgentToolLists))]
    public void AllowedTools_AllExist(string agentName, string[] allowedTools)
    {
        var registered = RegisteredToolNames();
        var missing = allowedTools.Where(t => !registered.Contains(t)).ToArray();

        Assert.True(missing.Length == 0,
            $"{agentName} allows tool(s) that no ITool implements: {string.Join(", ", missing)}. "
            + "SchemasFor drops these silently, so the model is never offered them — while the system "
            + "prompt may still be telling it to call them. Remove the name, or implement the tool.");
    }

    [Fact]
    public void AgentToolLists_FoundAtLeastOneAgent()
    {
        // A reflection-driven theory that finds nothing passes vacuously, which is the failure mode of
        // this kind of test. Renaming `AllTools` would do exactly that.
        Assert.NotEmpty(AgentToolLists());
    }
}
