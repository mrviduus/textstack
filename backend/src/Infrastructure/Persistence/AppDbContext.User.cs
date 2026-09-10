using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// User account configurations: end-user + admin user + refresh tokens +
/// password reset. UserLibrary lives here too (per-user "saved books" list).
/// </summary>
public partial class AppDbContext
{
    private static void ConfigureUser(ModelBuilder modelBuilder)
    {
        // User
        modelBuilder.Entity<User>(e =>
        {
            e.HasIndex(x => x.Email).IsUnique();
            e.HasIndex(x => x.GoogleSubject).IsUnique().HasFilter("google_subject IS NOT NULL");
            e.HasIndex(x => x.AppleSubject).IsUnique().HasFilter("apple_subject IS NOT NULL");
            e.Property(x => x.Email).HasMaxLength(255);
            e.Property(x => x.GoogleSubject).HasMaxLength(255);
            e.Property(x => x.AppleSubject).HasMaxLength(255);
            e.Property(x => x.PasswordHash).HasMaxLength(255);
            e.Property(x => x.Name).HasMaxLength(255);
            e.Property(x => x.NativeLanguage).HasMaxLength(16);
            e.Property(x => x.IsGuest).HasDefaultValue(false);
            // Stored as a string: readable in psql and immune to enum renumbering. House style for
            // new enum columns (cf. AppDbContext.Ai.cs). No index — tier is only ever read via the
            // already-loaded User row, never filtered on.
            e.Property(x => x.Tier)
                .HasConversion<string>()
                .HasMaxLength(20)
                .HasDefaultValue(UserTier.Free);
            e.HasIndex(x => new { x.IsGuest, x.LastActiveAt })
                .HasFilter("is_guest = true")
                .HasDatabaseName("ix_users_guest_cleanup");
        });

        // UserLibrary
        modelBuilder.Entity<UserLibrary>(e =>
        {
            e.HasIndex(x => x.EditionId);
            e.HasIndex(x => new { x.UserId, x.EditionId }).IsUnique();
            e.HasOne(x => x.User).WithMany(x => x.UserLibraries).HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Edition).WithMany().HasForeignKey(x => x.EditionId).OnDelete(DeleteBehavior.Cascade);
        });

        // AdminUser
        modelBuilder.Entity<AdminUser>(e =>
        {
            e.HasIndex(x => x.Email).IsUnique();
        });

        // AdminRefreshToken
        modelBuilder.Entity<AdminRefreshToken>(e =>
        {
            e.HasIndex(x => x.AdminUserId);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.Token).IsUnique();
            e.HasOne(x => x.AdminUser).WithMany(x => x.RefreshTokens).HasForeignKey(x => x.AdminUserId).OnDelete(DeleteBehavior.Cascade);
        });

        // UserRefreshToken
        modelBuilder.Entity<UserRefreshToken>(e =>
        {
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.Token).IsUnique();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // PasswordResetToken
        modelBuilder.Entity<PasswordResetToken>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.Property(x => x.TokenHash).HasMaxLength(128);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // DeviceAuthorization (RFC 8628 device-grant). device_code stored hashed.
        modelBuilder.Entity<DeviceAuthorization>(e =>
        {
            e.Property(x => x.DeviceCodeHash).HasMaxLength(128);
            e.Property(x => x.UserCode).HasMaxLength(16);
            e.Property(x => x.Status).HasMaxLength(16);
            e.HasIndex(x => x.DeviceCodeHash).IsUnique();
            // Lookup-by-user_code only matters for pending rows (approve step).
            e.HasIndex(x => x.UserCode).HasFilter("status = 'pending'");
            e.HasIndex(x => x.ExpiresAt);
            // User stays null until approved; SetNull keeps the audit row if the user is deleted.
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.SetNull);
        });
    }
}
