using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

public partial class AppDbContext
{
    // Instance (not static) like ConfigureInsights, and for the same reason: the query filter closes
    // over _currentSite. ConfigureUser next door is static, which is why this lives in its own file
    // rather than beside the other credential tables.
    private void ConfigureMcpKeys(ModelBuilder modelBuilder)
    {
        // The long-lived credential a reader pastes into their AI client. Hashed like
        // PasswordResetToken; revoked in place rather than deleted, so the row survives as the
        // record that a connector was switched off.
        modelBuilder.Entity<McpAccessKey>(e =>
        {
            e.HasIndex(x => x.KeyHash).IsUnique();
            e.Property(x => x.KeyHash).HasMaxLength(128);
            e.Property(x => x.Prefix).HasMaxLength(16);
            e.Property(x => x.Name).HasMaxLength(60);
            // The list-my-keys read. Revoked rows stay, so the index carries them too.
            e.HasIndex(x => new { x.UserId, x.SiteId });
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Site).WithMany().HasForeignKey(x => x.SiteId).OnDelete(DeleteBehavior.Cascade);
            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
