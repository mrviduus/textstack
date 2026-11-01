using Domain.Ops;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Ops;

// Neither table is user-owned: each test works under its own feature name or setting key.
public class EvalRunAndSettingsRepositoryTests(V2PostgresFixture db)
{
    private readonly EvalRunRepository _evals = new(db.DataSource);
    private readonly AdminSettingsRepository _settings = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static EvalScore Score(string feature, string runType = EvalScore.Manual, decimal score = 4.5m) => new()
    {
        Id = Guid.NewGuid(),
        Feature = feature,
        ModelId = "gpt-test",
        JudgeModelId = "judge-test",
        Score = score,
        N = 10,
        BreakdownJson = """{"clarity":4.5}""",
        RunType = runType,
    };

    [Fact]
    public async Task ListRecentAsync_FeatureAndRunType_ReturnsOnlyThoseNewestFirst()
    {
        var feature = "f-" + Guid.NewGuid();
        await _evals.AddAsync([Score(feature, EvalScore.Scheduled, 1m)], Ct);
        await _evals.AddAsync([Score(feature, EvalScore.Manual, 2m), Score("other-" + Guid.NewGuid(), EvalScore.Scheduled)], Ct);
        await _evals.AddAsync([Score(feature, EvalScore.Scheduled, 3m)], Ct);

        var scheduled = await _evals.ListRecentAsync(feature, EvalScore.Scheduled, 10, Ct);

        Assert.Equal([3m, 1m], scheduled.Select(s => s.Score));
        Assert.Equal(3, (await _evals.ListRecentAsync(feature, null, 10, Ct)).Count);
    }

    [Fact]
    public async Task ListRecentAsync_Limit_ReturnsTheNewestOnly()
    {
        var feature = "f-" + Guid.NewGuid();
        await _evals.AddAsync([Score(feature, score: 1m)], Ct);
        await _evals.AddAsync([Score(feature, score: 2m)], Ct);

        Assert.Equal(2m, Assert.Single(await _evals.ListRecentAsync(feature, null, 1, Ct)).Score);
    }

    [Fact]
    public async Task AddAsync_OneInvalidScore_StoresNone()
    {
        var feature = "f-" + Guid.NewGuid();

        await Assert.ThrowsAsync<PostgresException>(() => _evals.AddAsync([Score(feature), Score(feature, runType: "nightly")], Ct));

        Assert.Empty(await _evals.ListRecentAsync(feature, null, 10, Ct));
    }

    [Fact]
    public async Task GetAsync_UnsetKey_ReturnsNull() =>
        Assert.Null(await _settings.GetAsync("k-" + Guid.NewGuid(), Ct));

    [Fact]
    public async Task SetAsync_ExistingKey_ReplacesTheValue()
    {
        var key = "k-" + Guid.NewGuid();
        await _settings.SetAsync(key, "15", Ct);

        await _settings.SetAsync(key, "30", Ct);

        Assert.Equal("30", await _settings.GetAsync(key, Ct));
    }
}
