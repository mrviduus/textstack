using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>Stuck-job alerts go to Sentry as errors: once per change, then every 15 min, never when zero.</summary>
public class StuckJobsAlertTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 23, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ShouldAlert_ZeroStuck_Never() =>
        Assert.False(StuckJobsMetricsWorker.ShouldAlert(0, null, Now));

    [Fact]
    public void ShouldAlert_FirstTimeStuck_Alerts() =>
        Assert.True(StuckJobsMetricsWorker.ShouldAlert(1, null, Now));

    [Fact]
    public void ShouldAlert_SameCountSoonAfter_Quiet() =>
        Assert.False(StuckJobsMetricsWorker.ShouldAlert(2, (2, Now.AddMinutes(-1)), Now));

    [Fact]
    public void ShouldAlert_CountChanged_Alerts() =>
        Assert.True(StuckJobsMetricsWorker.ShouldAlert(3, (2, Now.AddMinutes(-1)), Now));

    [Fact]
    public void ShouldAlert_SameCountAfterRepeatWindow_AlertsAgain() =>
        Assert.True(StuckJobsMetricsWorker.ShouldAlert(2, (2, Now.AddMinutes(-15)), Now));
}
