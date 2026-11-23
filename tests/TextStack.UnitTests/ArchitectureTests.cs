using System.Reflection;
using NetArchTest.Rules;

namespace TextStack.UnitTests;

/// <summary>The layer rules of the modular monolith (ADR-034), checked on the compiled assemblies.</summary>
public class ArchitectureTests
{
    private static readonly string[] OurRoots = ["Domain", "Application", "Infrastructure", "Api", "Worker", "Contracts"];

    // Every backend assembly of ours in the test output, plus this test assembly.
    private static Assembly[] OurAssemblies() =>
        Directory.GetFiles(AppContext.BaseDirectory, "*.dll")
            .Select(Path.GetFileNameWithoutExtension)
            .Where(n => OurRoots.Contains(n) || n!.StartsWith("TextStack.", StringComparison.Ordinal))
            .Select(n => Assembly.Load(n!))
            .ToArray();

    private static void AssertPasses(NetArchTest.Rules.TestResult result, string rule) =>
        Assert.True(result.IsSuccessful,
            $"{rule}. Offending types:\n  " + string.Join("\n  ", result.FailingTypeNames ?? []));

    [Fact]
    public void Domain_ReferencesOtherProjectsOrDataAccess_HasNoSuchDependency()
    {
        var result = Types.InAssembly(Assembly.Load("Domain"))
            .ShouldNot()
            .HaveDependencyOnAny([.. OurRoots.Where(r => r != "Domain"), "TextStack", "Dapper", "Npgsql"])
            .GetResult();

        AssertPasses(result, "Domain must depend on no other project of ours and on no Dapper/Npgsql");
    }

    [Fact]
    public void Application_ReferencesDapperOrAspNetCore_HasNoSuchDependency()
    {
        var result = Types.InAssembly(Assembly.Load("Application"))
            .ShouldNot()
            .HaveDependencyOnAny("Dapper", "Microsoft.AspNetCore")
            .GetResult();

        AssertPasses(result, "Application must not use Dapper or ASP.NET Core");
    }

    [Fact]
    public void Infrastructure_ReferencesApiOrWorker_HasNoSuchDependency()
    {
        var result = Types.InAssembly(Assembly.Load("Infrastructure"))
            .ShouldNot()
            .HaveDependencyOnAny("Api", "Worker")
            .GetResult();

        AssertPasses(result, "Infrastructure must not depend on Api or Worker");
    }

    [Fact]
    public void RepositoryPorts_UsedByAnotherFeature_NoneExist()
    {
        var assemblies = OurAssemblies().Where(a => !a.GetName().Name!.EndsWith("Tests", StringComparison.Ordinal)).ToArray();
        var ports = Assembly.Load("Application").GetTypes()
            .Where(t => t.IsInterface && t.Name.StartsWith('I') && t.Name.EndsWith("Repository", StringComparison.Ordinal));

        var offenders = ports
            .SelectMany(port => Types.InAssemblies(assemblies)
                .That().HaveDependencyOn(port.FullName!)
                .And().DoNotResideInNamespace(port.Namespace!)
                .And().DoNotResideInNamespace("Infrastructure")
                .And().DoNotResideInNamespace("Api")
                .And().DoNotResideInNamespace("Worker")
                .GetTypes()
                .Select(user => $"{user.FullName} -> {port.Name}"))
            .ToList();

        Assert.True(offenders.Count == 0,
            "A feature may use only its own repository ports; another feature's goes through that feature's public port (IBookAccess, IChapterLookup, IAccountLookup, IReadingPositionReset, IAdminSessionLifetimes). Offending uses:\n  " + string.Join("\n  ", offenders));
    }

    [Fact]
    public void TypeNames_StartWithV2Prefix_NoneExist()
    {
        var offenders = Types.InAssemblies(OurAssemblies())
            .That().HaveNameMatching("^V2[A-Z]")
            .GetTypes()
            .Select(t => t.FullName)
            .ToList();

        Assert.True(offenders.Count == 0,
            "No type may be named V2* (the V2 program is over). Offending types:\n  " + string.Join("\n  ", offenders));
    }
}
