using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Application.Identity;

/// <summary>
/// The policy of every V2 step that follows a legacy one: the identity mirror in the Api and the guest
/// reaper in the Worker, in one place so the two cannot drift. Nothing runs unless <c>Features:V2Api</c>;
/// a step runs on its own budget, never the caller's token (a client gone after the legacy commit must
/// not cut it short, and legacy waits on V2 at most that long); a failure is an Error log naming both
/// ids, never an exception. Whether V2 is ready is the caller's concern: the Api checks its readiness
/// cache, the Worker relies on each step being safe to fail.
/// </summary>
public static class V2Follow
{
    public static readonly TimeSpan Budget = TimeSpan.FromSeconds(10);

    public static bool IsOn(IConfiguration config) => config.GetValue<bool>("Features:V2Api");

    /// <summary>Runs <paramref name="step"/> when V2 is on. False when it is off, or the step failed (logged; <paramref name="observe"/> sees the error).</summary>
    public static async Task<bool> RunAsync(
        IConfiguration config, ILogger logger, string stepName, Guid subjectId, Guid userId,
        Func<CancellationToken, Task> step, TimeSpan? budget = null, Action<Exception>? observe = null)
    {
        if (!IsOn(config)) return false;
        using var timeout = new CancellationTokenSource(budget ?? Budget);
        try
        {
            await step(timeout.Token);
            return true;
        }
        catch (Exception e)
        {
            observe?.Invoke(e);
            logger.LogError(e, "V2 {Step} failed for {SubjectUserId} → {UserId}; nothing legacy waits on it, the ETL sweep (#1094) collects what V2 keeps",
                stepName, subjectId, userId);
            return false;
        }
    }
}
