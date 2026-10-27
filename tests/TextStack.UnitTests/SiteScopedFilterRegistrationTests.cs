using Domain;
using Domain.Entities;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace TextStack.UnitTests;

// R1c metamodel guard. R1b delegated all single-site row scoping to EF global
// query filters (HasQueryFilter(x => x.SiteId == _currentSite.Id)) on every
// ISiteScoped entity, and R1c removed the now-redundant manual .Where(SiteId==)
// terms that used to back that up. If a future entity implements ISiteScoped
// but forgets its HasQueryFilter, it would silently leak rows across sites with
// no compile error — this test turns that into a red build.
//
// Builds the REAL production model (AppDbContextOptions, as the Api does).
// Model construction does not open a connection, so no live DB is needed. Query filters are read via the EF 10 API IReadOnlyEntityType
// .GetDeclaredQueryFilters() (named-filter aware; the parameterless
// GetQueryFilter() is the legacy single-filter accessor).
public class SiteScopedFilterRegistrationTests
{
    private static IModel BuildModel()
    {
        using var ctx = new AppDbContext(AppDbContextOptions.For("Host=localhost"), new CurrentSite(SiteConstants.DefaultSiteId));
        return ctx.Model;
    }

    [Fact]
    public void EverySiteScopedEntity_HasGlobalQueryFilter()
    {
        var model = BuildModel();

        var siteScoped = model.GetEntityTypes()
            .Where(et => typeof(ISiteScoped).IsAssignableFrom(et.ClrType))
            .ToList();

        // Guard against a silent no-op: the model must actually contain
        // ISiteScoped entities (21 as of R1b), otherwise the check below is vacuous.
        Assert.NotEmpty(siteScoped);

        var missing = siteScoped
            .Where(et => !et.GetDeclaredQueryFilters().Any())
            .Select(et => et.ClrType.Name)
            .OrderBy(n => n)
            .ToList();

        Assert.True(
            missing.Count == 0,
            $"ISiteScoped entities missing an EF global query filter (add HasQueryFilter): {string.Join(", ", missing)}");
    }

    [Theory]
    [InlineData("Site")]
    [InlineData("SiteDomain")]
    public void SiteResolverEntities_AreNotSiteScoped_AndHaveNoFilter(string entityName)
    {
        var model = BuildModel();

        var et = model.GetEntityTypes().FirstOrDefault(e => e.ClrType.Name == entityName);

        // The entity must exist in the model (else this test rots into a no-op
        // if the type is renamed).
        Assert.NotNull(et);

        // Deliberately excluded from site scoping: the site resolver reads these
        // to discover the current site, so filtering them would deadlock at zero rows.
        Assert.False(
            typeof(ISiteScoped).IsAssignableFrom(et!.ClrType),
            $"{entityName} must not implement ISiteScoped.");
        Assert.Empty(et.GetDeclaredQueryFilters());
    }
}
