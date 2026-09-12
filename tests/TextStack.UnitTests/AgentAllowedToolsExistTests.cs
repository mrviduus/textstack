using System.Reflection;
using System.Text.RegularExpressions;
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

    /// <summary>
    /// Every tool an agent's PROSE names must be one it is allowed to call.
    ///
    /// <para>The test above reflects over <c>AllowedTools</c> and cannot see a word. The Tutor's
    /// <c>BuildGoal</c> went on telling the model to "pull a real example sentence for a miss" for a
    /// day after <c>get_example_sentence</c> was deleted — on every re-plan turn, unobservably,
    /// because the instruction is prose and the guard read a string array.</para>
    ///
    /// <para><b>It cannot be written as "is this a registered tool".</b> The first version of this
    /// test was, and a mutation putting the dead instruction back left it green: the name belongs to
    /// no tool at all any more, which is exactly the case that hurts. So it matches the SHAPE of a
    /// tool name — this repo's tools are all <c>verb_noun</c> in snake_case — and requires every one
    /// it finds to be allowed.</para>
    /// </summary>
    [Fact]
    public void AgentProse_NamesNoToolTheAgentCannotCall()
    {
        var toolish = new Regex(@"\b(?:get|save|list|search|lookup|set)_[a-z][a-z_]{2,}\b", RegexOptions.Compiled);
        var offenders = new List<string>();

        foreach (var agent in typeof(TutorAgent).Assembly.GetTypes()
                     .Where(t => t.Namespace == "Application.Agents" && !t.IsAbstract))
        {
            var field = agent.GetField("AllTools", BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Public);
            if (field?.GetValue(null) is not string[] allowed) continue;

            // Comments are stripped: this file's own explanation names the dead tool, and so do the
            // notes left where an instruction was removed. What ships to the model is the strings.
            var source = StripComments(File.ReadAllText(SourcePathFor(agent)));

            foreach (Match m in toolish.Matches(source))
            {
                if (allowed.Contains(m.Value)) continue;
                offenders.Add($"{agent.Name} says '{m.Value}', which is not in its AllowedTools");
            }
        }

        Assert.True(offenders.Count == 0, string.Join("; ", offenders.Distinct())
            + ". An instruction naming a tool the model is not offered cannot be obeyed: it is paid "
            + "for on every run and can only degrade the plan. Remove the words, or allow the tool.");
    }

    /// <summary>
    /// What the model actually receives, approximately: comments dropped, and adjacent string
    /// literals glued.
    ///
    /// <para>The gluing is not cosmetic. These prompts wrap at 110 columns, so a tool name lands
    /// across a concatenation — <c>"…get_weak_" + "vocabulary…"</c> — and a naive scan reports
    /// <c>get_weak_</c>, a name no list will ever contain. The first version of this helper did
    /// exactly that and failed on a correct file.</para>
    /// </summary>
    private static string StripComments(string source)
    {
        source = Regex.Replace(source, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        source = Regex.Replace(source, @"//[^\n]*", " ");
        // "abc" + "def"  ->  "abcdef"   (also across newlines, and past a verbatim @ prefix)
        return Regex.Replace(source, "\"\\s*\\+\\s*@?\"", "");
    }

    /// <summary>The agent's own source file, found by name — these types are one-per-file.</summary>
    private static string SourcePathFor(Type agent)
    {
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
        var matches = Directory.GetFiles(Path.Combine(root, "backend/src/Application/Agents"),
            agent.Name + ".cs", SearchOption.AllDirectories);
        Assert.True(matches.Length == 1,
            $"expected exactly one source file for {agent.Name}, found {matches.Length} — this test "
            + "reads the file to see what the agent SAYS, so it must find it");
        return matches[0];
    }
}
