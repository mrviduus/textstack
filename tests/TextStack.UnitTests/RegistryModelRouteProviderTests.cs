using Application.Ai;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// RegistryModelRouteProvider: builds ONE snapshot (feature → primary provider_key) of the
/// Models registry inside a fresh scope, caches it under a short TTL, serves repeat reads
/// from cache (one scope build), and rebuilds after Invalidate. Models set is a List behind a
/// Moq DbSet (async LINQ via TestAsyncQueryable); the scope factory counts builds.
/// </summary>
public class RegistryModelRouteProviderTests
{
    private sealed class Harness
    {
        public List<ModelRegistration> Models { get; } = [];
        public int ScopeBuilds { get; private set; }
        public RegistryModelRouteProvider Provider { get; }

        public Harness()
        {
            var db = new Mock<IAppDbContext>();
            db.Setup(x => x.Models).Returns(() => FakeSet(Models).Object);

            var scope = new Mock<IServiceScope>();
            var sp = new Mock<IServiceProvider>();
            sp.Setup(x => x.GetService(typeof(IAppDbContext))).Returns(() => db.Object);
            scope.Setup(x => x.ServiceProvider).Returns(sp.Object);

            var factory = new Mock<IServiceScopeFactory>();
            factory.Setup(x => x.CreateScope()).Returns(() => { ScopeBuilds++; return scope.Object; });

            var cache = new MemoryCache(new MemoryCacheOptions());
            var config = new ConfigurationBuilder().Build(); // default TTL 30s
            Provider = new RegistryModelRouteProvider(
                factory.Object, cache, config, NullLogger<RegistryModelRouteProvider>.Instance);
        }

        public void AddPrimary(string feature, string provider) =>
            Models.Add(new ModelRegistration
            {
                Id = Guid.NewGuid(),
                FeatureTag = feature,
                ProviderKey = provider,
                ModelId = "m",
                Status = ModelStatus.Primary,
                CreatedAt = DateTimeOffset.UtcNow,
            });
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        return set;
    }

    [Fact]
    public void PrimaryProviderKey_BuildsSnapshot_ReturnsPrimaryKey()
    {
        var h = new Harness();
        h.AddPrimary("explain", "openai-explain");
        h.AddPrimary("translate", "openai");

        Assert.Equal("openai-explain", h.Provider.PrimaryProviderKey("explain"));
        Assert.Equal("openai", h.Provider.PrimaryProviderKey("translate"));
        Assert.Null(h.Provider.PrimaryProviderKey("no-such-feature"));
    }

    [Fact]
    public void PrimaryProviderKey_OnlyPrimaryRows_AreSnapshotted()
    {
        var h = new Harness();
        h.AddPrimary("explain", "openai-explain");
        h.Models.Add(new ModelRegistration
        {
            Id = Guid.NewGuid(),
            FeatureTag = "explain",
            ProviderKey = "ollama",
            ModelId = "m",
            Status = ModelStatus.Shadow,
            CreatedAt = DateTimeOffset.UtcNow,
        });

        Assert.Equal("openai-explain", h.Provider.PrimaryProviderKey("explain")); // shadow ignored
    }

    [Fact]
    public void PrimaryProviderKey_WithinTtl_ServedFromCache_OneBuild()
    {
        var h = new Harness();
        h.AddPrimary("explain", "openai-explain");

        for (var i = 0; i < 5; i++)
            Assert.Equal("openai-explain", h.Provider.PrimaryProviderKey("explain"));

        Assert.Equal(1, h.ScopeBuilds); // built once, then cached
    }

    [Fact]
    public void Invalidate_ForcesRebuild_AndPicksUpNewPrimary()
    {
        var h = new Harness();
        h.AddPrimary("explain", "openai");
        Assert.Equal("openai", h.Provider.PrimaryProviderKey("explain"));
        Assert.Equal(1, h.ScopeBuilds);

        // Simulate a promotion: swap the registry's Primary.
        h.Models.Clear();
        h.AddPrimary("explain", "openai-explain");

        // Still cached → stale until invalidated.
        Assert.Equal("openai", h.Provider.PrimaryProviderKey("explain"));
        Assert.Equal(1, h.ScopeBuilds);

        h.Provider.Invalidate();
        Assert.Equal("openai-explain", h.Provider.PrimaryProviderKey("explain"));
        Assert.Equal(2, h.ScopeBuilds); // rebuilt after invalidate
    }

    [Fact]
    public void PrimaryProviderKey_TwoPrimariesSameFeature_DoesNotThrow_DeterministicWinner()
    {
        // Defends the LLM hot path: if the partial unique index ever fails to enforce
        // one-Primary-per-feature (bad migration filter, manual DB edit), the snapshot build
        // must NOT crash via a duplicate-key ToDictionary — every call for that feature would
        // 500. It must return a deterministic winner (oldest CreatedAt) and keep serving.
        var h = new Harness();
        h.Models.Add(new ModelRegistration
        {
            Id = Guid.NewGuid(),
            FeatureTag = "explain",
            ProviderKey = "openai-explain",
            ModelId = "m",
            Status = ModelStatus.Primary,
            CreatedAt = DateTimeOffset.UtcNow.AddDays(-2), // older → wins
        });
        h.Models.Add(new ModelRegistration
        {
            Id = Guid.NewGuid(),
            FeatureTag = "explain",
            ProviderKey = "ollama",
            ModelId = "m",
            Status = ModelStatus.Primary,
            CreatedAt = DateTimeOffset.UtcNow.AddDays(-1),
        });

        var key = h.Provider.PrimaryProviderKey("explain"); // must not throw
        Assert.Equal("openai-explain", key); // oldest deterministically wins
    }

    [Fact]
    public void PrimaryProviderKey_NullOrBlankFeature_ReturnsNull_NoBuild()
    {
        var h = new Harness();
        Assert.Null(h.Provider.PrimaryProviderKey(""));
        Assert.Null(h.Provider.PrimaryProviderKey("   "));
        Assert.Equal(0, h.ScopeBuilds);
    }
}
