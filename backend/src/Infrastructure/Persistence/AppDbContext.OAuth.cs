using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

public partial class AppDbContext
{
    // OAuth authorization server for MCP (ADR-017). No site filter: like DeviceAuthorization these
    // are credentials, keyed by hash, and the product is single-site (ADR-007).
    private static void ConfigureOAuth(ModelBuilder modelBuilder)
    {
        // Explicit names: the snake_case convention would split "OAuth" into "o_auth_".
        modelBuilder.Entity<OAuthClient>(e =>
        {
            e.ToTable("oauth_clients");
            e.HasIndex(x => x.ClientId).IsUnique();
            e.Property(x => x.ClientId).HasMaxLength(512);
            e.Property(x => x.ClientName).HasMaxLength(100);
        });

        modelBuilder.Entity<OAuthAuthorizationRequest>(e =>
        {
            e.ToTable("oauth_authorization_requests");
            e.HasIndex(x => x.CodeHash).IsUnique();
            e.HasIndex(x => x.CreatedAt); // the sweep
            e.Property(x => x.ClientId).HasMaxLength(512);
            e.Property(x => x.ClientName).HasMaxLength(100);
            e.Property(x => x.RedirectUri).HasMaxLength(2048);
            e.Property(x => x.State).HasMaxLength(1024);
            e.Property(x => x.CodeChallenge).HasMaxLength(128);
            e.Property(x => x.Resource).HasMaxLength(512);
            e.Property(x => x.Scope).HasMaxLength(200);
            e.Property(x => x.CodeHash).HasMaxLength(128);
        });

        modelBuilder.Entity<OAuthGrant>(e =>
        {
            e.ToTable("oauth_grants");
            e.HasIndex(x => x.AccessTokenHash).IsUnique();
            e.HasIndex(x => x.RefreshTokenHash).IsUnique();
            e.HasIndex(x => x.UserId); // the connected-apps list
            e.Property(x => x.ClientId).HasMaxLength(512);
            e.Property(x => x.ClientName).HasMaxLength(100);
            e.Property(x => x.RedirectUri).HasMaxLength(2048);
            e.Property(x => x.Resource).HasMaxLength(512);
            e.Property(x => x.Scope).HasMaxLength(200);
            e.Property(x => x.AccessTokenHash).HasMaxLength(128);
            e.Property(x => x.RefreshTokenHash).HasMaxLength(128);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
