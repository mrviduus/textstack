using Api.Extensions;

namespace TextStack.UnitTests;

/// <summary>
/// /health/ready compares the migrations embedded in the Api with the ledger (ADR-026). If the
/// embedding broke, every schema would read as up to date.
/// </summary>
public class SchemaVersionTests
{
    [Fact]
    public void Known_EmbeddedFromDatabaseFolder_StartsWithBaseline() =>
        Assert.Equal("0000_baseline", SchemaVersion.Known[0]);

    [Fact]
    public void Pending_SomeApplied_ReturnsTheRestInOrder() =>
        Assert.Equal(["0001_a", "0003_c"], SchemaVersion.Pending(["0000_baseline", "0001_a", "0002_b", "0003_c"], [0, 2]));

    [Fact]
    public void Pending_AppliedVersionsUnknownToBuild_AreIgnored() =>
        Assert.Empty(SchemaVersion.Pending(["0000_baseline"], [0, 1, 2]));

    [Fact]
    public void Pending_NothingApplied_ReturnsAll() =>
        Assert.Equal(["0000_baseline"], SchemaVersion.Pending(["0000_baseline"], []));
}
