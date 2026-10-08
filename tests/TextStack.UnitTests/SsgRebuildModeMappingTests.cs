using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace TextStack.UnitTests;

/// <summary>
/// Full is the only SSG rebuild mode (2026-10-08). Rows written as Incremental or Specific before that
/// must still load in the admin history, so the column's converter reads any string as Full instead of
/// throwing. Builds the real AppDbContext model (Npgsql, never connects) and asks the real converter.
/// </summary>
public class SsgRebuildModeMappingTests
{
    [Theory]
    [InlineData("Full")]
    [InlineData("Incremental")]
    [InlineData("Specific")]
    [InlineData("anything")]
    public void ModeConverter_AnyStoredString_ReadsAsFull(string stored)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=unused", o => o.UseVector())
            .UseSnakeCaseNamingConvention()
            .Options;
        using var db = new AppDbContext(options, new CurrentSite(Guid.NewGuid()));

        var converter = db.Model.FindEntityType(typeof(SsgRebuildJob))!
            .FindProperty(nameof(SsgRebuildJob.Mode))!.GetValueConverter()!;

        Assert.Equal(SsgRebuildMode.Full, converter.ConvertFromProvider(stored));
        Assert.Equal("Full", converter.ConvertToProvider(SsgRebuildMode.Full));
    }
}
