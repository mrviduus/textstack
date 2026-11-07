using Api.V2;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests.V2;

public class EtlV2CommandTests
{
    private static readonly IConfiguration Config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["ConnectionStrings:Default"] = "Host=db;Database=textstack",
        ["ConnectionStrings:V2"] = "Host=db;Database=textstack_v2",
    }).Build();

    [Fact]
    public void Parse_NoArguments_ConfiguredDatabasesAndWrites()
    {
        var options = EtlV2Command.Parse([], Config);

        Assert.Equal(new("Host=db;Database=textstack", "Host=db;Database=textstack_v2", false), options);
    }

    [Fact]
    public void Parse_AllFlags_Overrides()
    {
        var options = EtlV2Command.Parse(["--target", "t", "--dry-run", "--source", "s"], Config);

        Assert.Equal(new("s", "t", true), options);
    }

    [Theory]
    [InlineData("--source")]
    [InlineData("--dryrun")]
    [InlineData("extra")]
    public void Parse_UnknownOrValuelessArgument_Null(string arg) =>
        Assert.Null(EtlV2Command.Parse([arg], Config));

    [Fact]
    public void Parse_NoTargetConfigured_Null() =>
        Assert.Null(EtlV2Command.Parse([], new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Default"] = "Host=db",
        }).Build()));

    [Fact]
    public async Task RunAsync_BadArguments_UsageAndExit2()
    {
        var error = new StringWriter();

        var exit = await EtlV2Command.RunAsync(["--bogus"], Config, TextWriter.Null, error);

        Assert.Equal(2, exit);
        Assert.StartsWith("usage: etl-v2", error.ToString());
    }

    [Fact]
    public async Task RunAsync_Unparseable_Exit1WithoutQuotingSecret()
    {
        var error = new StringWriter();

        var exit = await EtlV2Command.RunAsync(["--source", "Password=hunter2;Bogus Key=1"], Config, TextWriter.Null, error);

        Assert.Equal(1, exit);
        Assert.DoesNotContain("hunter2", error.ToString());
    }
}
