using Application.Ai;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Domain.Exceptions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Moq;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// Promote/rollback transitions over a Moq <see cref="IAppDbContext"/> whose Models +
/// ModelPromotions sets are backed by plain List&lt;T&gt; (async LINQ via TestAsyncQueryable —
/// the production AppDbContext can't load on EF InMemory). Asserts the registry swap, the
/// one-Primary invariant, the audit row, rejections, and a symmetric rollback. The route
/// provider is a spy so we can assert Invalidate() fires after a commit.
/// </summary>
public class ModelPromotionServiceTests
{
    private sealed class Harness
    {
        public List<ModelRegistration> Models { get; } = [];
        public List<ModelPromotion> Promotions { get; } = [];
        public int SaveCalls { get; private set; }
        public int CommitCalls { get; private set; }
        public int RollbackCalls { get; private set; }
        public SpyRouteProvider Routes { get; } = new();
        public ModelPromotionService Service { get; }

        /// <summary>When set, SaveChangesAsync throws this on the Nth call (1-based) to
        /// simulate the partial-unique-index violation a concurrent promote triggers.</summary>
        public Exception? ThrowOnSaveCall { get; set; }
        public int ThrowOnSaveCallNumber { get; set; } = 1;

        public Harness()
        {
            var db = new Mock<IAppDbContext>();
            db.Setup(x => x.Models).Returns(() => FakeSet(Models).Object);
            db.Setup(x => x.ModelPromotions).Returns(() => FakeSet(Promotions).Object);
            db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()))
                .ReturnsAsync(() =>
                {
                    SaveCalls++;
                    if (ThrowOnSaveCall is not null && SaveCalls == ThrowOnSaveCallNumber)
                        throw ThrowOnSaveCall;
                    return 0;
                });

            var tx = new Mock<IDbContextTransaction>();
            tx.Setup(x => x.CommitAsync(It.IsAny<CancellationToken>()))
                .Returns(() => { CommitCalls++; return Task.CompletedTask; });
            tx.Setup(x => x.RollbackAsync(It.IsAny<CancellationToken>()))
                .Returns(() => { RollbackCalls++; return Task.CompletedTask; });
            db.Setup(x => x.BeginTransactionAsync(It.IsAny<CancellationToken>()))
                .ReturnsAsync(tx.Object);

            Service = new ModelPromotionService(db.Object, Routes);
        }

        public ModelRegistration AddModel(string feature, string provider, string model, ModelStatus status)
        {
            var m = new ModelRegistration
            {
                Id = Guid.NewGuid(),
                FeatureTag = feature,
                ProviderKey = provider,
                ModelId = model,
                Status = status,
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-1),
            };
            Models.Add(m);
            return m;
        }
    }

    private sealed class SpyRouteProvider : IModelRouteProvider
    {
        public int InvalidateCount { get; private set; }
        public string? PrimaryProviderKey(string featureTag) => null;
        public void Invalidate() => InvalidateCount++;
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
        set.Setup(m => m.Add(It.IsAny<T>())).Callback<T>(e => data.Add(e));
        return set;
    }

    // ── Promote ───────────────────────────────────────────────────────────────────

    [Fact]
    public async Task PromoteAsync_ShadowToPrimary_FlipsBoth_AndWritesAudit()
    {
        var h = new Harness();
        var outgoing = h.AddModel("explain", "openai", "gpt-4.1-nano", ModelStatus.Primary);
        var target = h.AddModel("explain", "openai-explain", "gpt-4.1-mini", ModelStatus.Shadow);
        var admin = Guid.NewGuid();

        var result = await h.Service.PromoteAsync(target.Id, admin, CancellationToken.None);

        Assert.Equal(ModelStatus.Primary, target.Status);     // target promoted
        Assert.Equal(ModelStatus.Shadow, outgoing.Status);    // outgoing demoted
        Assert.Equal(target.Id, result.NewPrimary.Id);
        Assert.Equal(outgoing.Id, result.DemotedToShadow!.Id);
        Assert.Equal(PromotionAction.Promote, result.Action);

        // Exactly one feature has a Primary (invariant).
        Assert.Single(h.Models, m => m is { FeatureTag: "explain", Status: ModelStatus.Primary });

        // Audit row with denormalized keys + admin.
        var audit = Assert.Single(h.Promotions);
        Assert.Equal(PromotionAction.Promote, audit.Action);
        Assert.Equal(outgoing.Id, audit.FromModelRegistrationId);
        Assert.Equal("openai", audit.FromProviderKey);
        Assert.Equal(target.Id, audit.ToModelRegistrationId);
        Assert.Equal("openai-explain", audit.ToProviderKey);
        Assert.Equal(admin, audit.AdminUserId);

        Assert.Equal(1, h.Routes.InvalidateCount); // cache flipped after commit
    }

    [Fact]
    public async Task PromoteAsync_NoExistingPrimary_FirstPromotion_FromIsNull()
    {
        var h = new Harness();
        var target = h.AddModel("tagsuggestion", "ollama", "gemma4:e2b", ModelStatus.Shadow);

        var result = await h.Service.PromoteAsync(target.Id, null, CancellationToken.None);

        Assert.Equal(ModelStatus.Primary, target.Status);
        Assert.Null(result.DemotedToShadow);
        var audit = Assert.Single(h.Promotions);
        Assert.Null(audit.FromModelRegistrationId);
    }

    [Fact]
    public async Task PromoteAsync_NotFound_Throws()
    {
        var h = new Harness();
        await Assert.ThrowsAsync<DomainException>(() =>
            h.Service.PromoteAsync(Guid.NewGuid(), null, CancellationToken.None));
        Assert.Equal(0, h.Routes.InvalidateCount);
    }

    [Fact]
    public async Task PromoteAsync_Retired_Throws()
    {
        var h = new Harness();
        var retired = h.AddModel("explain", "openai", "old", ModelStatus.Retired);
        await Assert.ThrowsAsync<DomainException>(() =>
            h.Service.PromoteAsync(retired.Id, null, CancellationToken.None));
        Assert.Equal(ModelStatus.Retired, retired.Status); // untouched
    }

    [Fact]
    public async Task PromoteAsync_AlreadyPrimary_Throws()
    {
        var h = new Harness();
        var primary = h.AddModel("explain", "openai", "gpt", ModelStatus.Primary);
        await Assert.ThrowsAsync<DomainException>(() =>
            h.Service.PromoteAsync(primary.Id, null, CancellationToken.None));
    }

    // ── Rollback ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task RollbackAsync_RestoresPriorPrimary_Symmetrically()
    {
        var h = new Harness();
        var a = h.AddModel("explain", "openai", "nano", ModelStatus.Primary);   // original primary
        var b = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);

        // Promote b (a → Shadow, b → Primary).
        await h.Service.PromoteAsync(b.Id, null, CancellationToken.None);
        Assert.Equal(ModelStatus.Primary, b.Status);
        Assert.Equal(ModelStatus.Shadow, a.Status);

        // Rollback: a → Primary again, b → Shadow.
        var result = await h.Service.RollbackAsync("explain", null, CancellationToken.None);

        Assert.Equal(ModelStatus.Primary, a.Status);
        Assert.Equal(ModelStatus.Shadow, b.Status);
        Assert.Equal(a.Id, result.NewPrimary.Id);
        Assert.Equal(b.Id, result.DemotedToShadow!.Id);
        Assert.Equal(PromotionAction.Rollback, result.Action);

        // Invariant holds + a Rollback audit row was appended.
        Assert.Single(h.Models, m => m is { FeatureTag: "explain", Status: ModelStatus.Primary });
        Assert.Equal(2, h.Promotions.Count);
        Assert.Equal(PromotionAction.Rollback, h.Promotions[^1].Action);
        Assert.Equal(2, h.Routes.InvalidateCount); // promote + rollback
    }

    [Fact]
    public async Task RollbackAsync_NoPriorPromotion_Conflicts()
    {
        var h = new Harness();
        h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        await Assert.ThrowsAsync<ConflictException>(() =>
            h.Service.RollbackAsync("explain", null, CancellationToken.None));
    }

    // ── Concurrency / atomicity (the partial-unique-index invariant) ────────────────

    [Fact]
    public async Task PromoteAsync_ConcurrentPromote_IndexViolation_SurfacesConflict_NoInvalidate()
    {
        // Two admins promote different shadows for the same feature at once: the loser's
        // SaveChanges violates the (feature_tag) WHERE status='Primary' partial unique index.
        // EF surfaces DbUpdateException → the service MUST map it to ConflictException (→409),
        // NOT a 500, and MUST NOT invalidate the route cache (the swap never committed).
        var h = new Harness
        {
            ThrowOnSaveCall = new DbUpdateException("23505: duplicate key value violates unique constraint"),
        };
        h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        var target = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);

        await Assert.ThrowsAsync<ConflictException>(() =>
            h.Service.PromoteAsync(target.Id, null, CancellationToken.None));

        Assert.Equal(0, h.CommitCalls);          // never committed
        Assert.Equal(0, h.Routes.InvalidateCount); // cache NOT flipped on a failed swap
    }

    [Fact]
    public async Task RollbackAsync_ConcurrentChange_IndexViolation_SurfacesConflict_NoInvalidate()
    {
        var h = new Harness
        {
            ThrowOnSaveCall = new DbUpdateException("23505"),
            ThrowOnSaveCallNumber = 99, // don't throw during the setup promote
        };
        var a = h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        var b = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);
        await h.Service.PromoteAsync(b.Id, null, CancellationToken.None); // 1st save ok
        var invalidatesAfterPromote = h.Routes.InvalidateCount;

        // Next save (the rollback) throws the index violation.
        h.ThrowOnSaveCallNumber = h.SaveCalls + 1;
        await Assert.ThrowsAsync<ConflictException>(() =>
            h.Service.RollbackAsync("explain", null, CancellationToken.None));

        Assert.Equal(invalidatesAfterPromote, h.Routes.InvalidateCount); // rollback did NOT invalidate
    }

    [Fact]
    public async Task RollbackAsync_RestoreTargetGone_Conflicts_Not500()
    {
        // The prior primary row was deleted/retired-away since the promotion: rollback must
        // surface a clean ConflictException (→409), never a NullReference/500.
        var h = new Harness();
        var a = h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        var b = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);
        await h.Service.PromoteAsync(b.Id, null, CancellationToken.None);

        h.Models.Remove(a); // the model we'd roll back TO no longer exists

        await Assert.ThrowsAsync<ConflictException>(() =>
            h.Service.RollbackAsync("explain", null, CancellationToken.None));
    }

    [Fact]
    public async Task RollbackAsync_RestoreTargetRetired_Conflicts()
    {
        var h = new Harness();
        var a = h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        var b = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);
        await h.Service.PromoteAsync(b.Id, null, CancellationToken.None);

        a.Status = ModelStatus.Retired; // prior primary was retired since the promotion

        await Assert.ThrowsAsync<ConflictException>(() =>
            h.Service.RollbackAsync("explain", null, CancellationToken.None));
    }

    [Fact]
    public async Task PromoteAsync_PicksLatestPromotionForRollback_NotAnOlderFeaturesRow()
    {
        // Rollback must read the latest promotion FOR THIS feature only — an interleaved
        // promotion of a DIFFERENT feature must not be mistaken for the one to revert.
        var h = new Harness();
        var ex1 = h.AddModel("explain", "openai", "nano", ModelStatus.Primary);
        var ex2 = h.AddModel("explain", "openai-explain", "mini", ModelStatus.Shadow);
        var tr1 = h.AddModel("translate", "openai", "nano", ModelStatus.Primary);
        var tr2 = h.AddModel("translate", "ollama", "gemma", ModelStatus.Shadow);

        await h.Service.PromoteAsync(ex2.Id, null, CancellationToken.None); // explain: ex1→shadow, ex2→primary
        await h.Service.PromoteAsync(tr2.Id, null, CancellationToken.None); // translate (newer audit row)

        var result = await h.Service.RollbackAsync("explain", null, CancellationToken.None);

        Assert.Equal(ex1.Id, result.NewPrimary.Id);     // restored explain's prior primary
        Assert.Equal(ModelStatus.Primary, ex1.Status);
        Assert.Equal(ModelStatus.Shadow, ex2.Status);
        Assert.Equal(ModelStatus.Primary, tr2.Status);  // translate untouched
    }
}
