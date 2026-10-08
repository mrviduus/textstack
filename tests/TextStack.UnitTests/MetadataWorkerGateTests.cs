using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// The batch gate. This is not an optimisation — it prevents data loss.
///
/// <c>UserBookEnrichmentService.EnrichAsync</c> stamps <c>Completed</c> (not <c>Failed</c>) when the
/// generator returns null, which is exactly what an unreachable provider produces. Claiming rows
/// during an outage therefore drains the queue into a terminal "done, nothing filled" state that
/// nothing revisits. Leaving them Pending costs one skipped cycle and loses nothing.
/// </summary>
public class MetadataWorkerGateTests
{
    [Fact]
    public void ShouldDrainPending_PrimaryAvailable_True() =>
        Assert.True(MetadataEnrichmentWorker.ShouldDrainPending(primaryAvailable: true, fallbackAvailable: false));

    /// <summary>The agent path can be down while the Ollama fallback still answers — that is a
    /// perfectly good reason to keep draining.</summary>
    [Fact]
    public void ShouldDrainPending_OnlyFallbackAvailable_True() =>
        Assert.True(MetadataEnrichmentWorker.ShouldDrainPending(primaryAvailable: false, fallbackAvailable: true));

    /// <summary>The invariant: with nothing able to answer, rows must stay queued.</summary>
    [Fact]
    public void ShouldDrainPending_NeitherAvailable_False() =>
        Assert.False(MetadataEnrichmentWorker.ShouldDrainPending(primaryAvailable: false, fallbackAvailable: false));

    [Fact]
    public void ShouldDrainPending_BothAvailable_True() =>
        Assert.True(MetadataEnrichmentWorker.ShouldDrainPending(primaryAvailable: true, fallbackAvailable: true));

    /// <summary>The worker's tags must match what the generators actually send, or the gate would
    /// consult a provider the work never uses.</summary>
    [Fact]
    public void FeatureTags_MatchTheRoutesTheyGate()
    {
        Assert.Equal("bookmeta", MetadataEnrichmentWorker.FallbackFeatureTag);
        Assert.Equal("bookmeta.agent", MetadataEnrichmentWorker.PrimaryFeatureTag);
    }
}
