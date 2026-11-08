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

    [Theory]
    [InlineData("--target")]
    [InlineData("--dry-run", "--target")]
    public void Parse_TrailingFlagWithoutValue_Null(params string[] args) =>
        Assert.Null(EtlV2Command.Parse(args, Config));

    [Theory]
    [InlineData("--source", "")]
    [InlineData("--target", "  ")]
    public void Parse_BlankConnectionString_Null(string flag, string value) =>
        Assert.Null(EtlV2Command.Parse([flag, value], Config));

    [Fact]
    public void Parse_DryRunTwice_DryRun() =>
        Assert.True(EtlV2Command.Parse(["--dry-run", "--dry-run"], Config)!.DryRun);

    [Theory]
    [InlineData("Host=db;Password=hunter2;Port=abc")]
    [InlineData("Host=db;Password=hunter2;Timeout=-5")]
    [InlineData("Host=db;Password=hunter2;SSL Mode=bogus")]
    [InlineData("Host=db;Password=\"hunter2;Bogus")]
    [InlineData("Password='hunter2")]
    public async Task RunAsync_BadValueInConnectionString_Exit1WithoutQuotingSecret(string source)
    {
        var (output, error) = (new StringWriter(), new StringWriter());

        var exit = await EtlV2Command.RunAsync(["--dry-run", "--source", source], Config, output, error);

        Assert.Equal(1, exit);
        Assert.DoesNotContain("hunter2", output.ToString() + error.ToString());
    }

    [Fact]
    public async Task RunAsync_UnreachableServer_Exit1WithoutQuotingSecret()
    {
        var (output, error) = (new StringWriter(), new StringWriter());
        const string cs = "Host=127.0.0.1;Port=1;Database=x;Username=u;Password=hu'nt;er\"2;Timeout=3";

        var exit = await EtlV2Command.RunAsync(["--dry-run", "--source", cs.Replace("Password=hu'nt;er\"2", "Password='hu''nt;er\"2'"), "--target", cs.Replace("Password=hu'nt;er\"2", "Password='hu''nt;er\"2'")],
            Config, output, error);

        Assert.Equal(1, exit);
        Assert.StartsWith("etl-v2: ", error.ToString());
        // The message only: the wrapped exception and its stack trace are not printed.
        Assert.DoesNotContain("   at ", error.ToString());
        Assert.DoesNotContain("nt;er", output.ToString() + error.ToString());
        Assert.Empty(output.ToString());
    }

    [Fact]
    public void Parse_SourceDumpSha_Kept()
    {
        var sha = new string('0', 32) + new string('f', 32);

        Assert.Equal(sha, EtlV2Command.Parse(["--source-dump-sha", sha], Config)!.SourceDumpSha);
    }

    [Theory]
    [InlineData("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")]
    [InlineData("abc")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n")]
    public async Task RunAsync_BadSourceDumpSha_Exit2(string sha)
    {
        var error = new StringWriter();

        var exit = await EtlV2Command.RunAsync(["--source-dump-sha", sha.Replace("\\n", "\n")], Config, TextWriter.Null, error);

        Assert.Equal(2, exit);
        Assert.StartsWith("usage: etl-v2", error.ToString());
    }

    [Fact]
    public void Parse_SourceDumpShaWithoutValue_Null() =>
        Assert.Null(EtlV2Command.Parse(["--source-dump-sha"], Config));
}
