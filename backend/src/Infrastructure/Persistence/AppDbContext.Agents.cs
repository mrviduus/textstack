using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// Agent persistence (Phase 6 / AI-036). <see cref="AgentRun"/> (table <c>agent_run</c>) — one row per
/// finished agent run (Study Buddy and future agents) so the reader UI can replay its steps and runs
/// are observable. snake_case names come from the global convention (OnConfiguring).
/// </summary>
public partial class AppDbContext
{
    // Instance (not static): the TutorSession query filter closes over _currentSite.
    private void ConfigureAgents(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AgentRun>(e =>
        {
            e.ToTable("agent_run");

            // Hot query: a user's recent runs (the "my Study Buddy runs" lookup).
            e.HasIndex(x => new { x.UserId, x.CreatedAt }).HasFilter("user_id IS NOT NULL");

            e.Property(x => x.Agent).HasMaxLength(64);
            e.Property(x => x.Status).HasMaxLength(32);
            e.Property(x => x.StepsJson).HasColumnType("jsonb");
            e.Property(x => x.CostUsd).HasColumnType("numeric(10,6)");
            // Telemetry (AI-Agent-1): agent-reported confidence + tool-call count, charted in the
            // admin AI-quality page. Nullable confidence — only agents that calibrate set it.
            e.Property(x => x.Confidence).HasColumnType("double precision");
            e.Property(x => x.ToolCallsCount).HasDefaultValue(0);

            // Optional FK → users. Account delete removes the user's runs first (AccountEndpoints),
            // so SetNull only covers deletes outside that path.
            e.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        // Learning Tutor session state (AI-Agent-2). One row per multi-turn micro-session, holding the current
        // plan between HITL turns. PlanJson is jsonb (read whole). Deleting the user cascades their sessions.
        modelBuilder.Entity<TutorSession>(e =>
        {
            e.ToTable("tutor_session");

            // Hot query: the user's most recent active session (resume / re-plan lookup).
            e.HasIndex(x => new { x.UserId, x.Status, x.UpdatedAt });

            e.Property(x => x.PlanJson).HasColumnType("jsonb");
            e.Property(x => x.AppliedWordIdsJson).HasColumnType("jsonb");
            e.Property(x => x.Status).HasMaxLength(16);

            e.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(x => x.Site)
                .WithMany()
                .HasForeignKey(x => x.SiteId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasQueryFilter(x => x.SiteId == _currentSite.Id);
        });
    }
}
