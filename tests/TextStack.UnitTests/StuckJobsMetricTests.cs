using System.Diagnostics.Metrics;
using Infrastructure.Telemetry;

namespace TextStack.UnitTests;

/// <summary><c>queue_stuck_jobs</c> reports the last count set for each queue, tagged by queue name.</summary>
public class StuckJobsMetricTests
{
    [Fact]
    public void SetStuckJobs_PerQueue_ObservedWithQueueTag()
    {
        IngestionMetrics.SetStuckJobs("test_queue_a", 3);
        IngestionMetrics.SetStuckJobs("test_queue_b", 0);
        IngestionMetrics.SetStuckJobs("test_queue_a", 5);

        var seen = new Dictionary<string, int>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (inst, l) =>
        {
            if (inst.Name == "queue_stuck_jobs") l.EnableMeasurementEvents(inst);
        };
        listener.SetMeasurementEventCallback<int>((_, value, tags, _) =>
        {
            foreach (var t in tags)
                if (t.Key == "queue") seen[(string)t.Value!] = value;
        });
        listener.Start();
        listener.RecordObservableInstruments();

        Assert.Equal(5, seen["test_queue_a"]);
        Assert.Equal(0, seen["test_queue_b"]);
    }
}
