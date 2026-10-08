using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Pgvector;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DropDriftCentroidsAndSsgPeriodicSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // ADR-023: DriftDetectionWorker (OFF in prod, table written by nothing else) is deleted.
            migrationBuilder.DropTable(
                name: "drift_centroids");

            // ADR-023: SsgPeriodicRebuildWorker is deleted; backup.yml's nightly run is the only schedule.
            // Not restored by Down: both keys are optional (their readers had defaults) and gone with them.
            migrationBuilder.Sql(
                "DELETE FROM admin_settings WHERE key IN ('ssg.periodicRebuildEnabled', 'ssg.periodicRebuildIntervalHours');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "drift_centroids",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    alert_state = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    alerted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    centroid = table.Column<Vector>(type: "vector(1536)", nullable: true),
                    consecutive_breaches = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    day = table.Column<DateOnly>(type: "date", nullable: false),
                    drift_score = table.Column<double>(type: "numeric(6,4)", nullable: true),
                    feature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    sample_size = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_drift_centroids", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_drift_centroids_feature_day",
                table: "drift_centroids",
                columns: new[] { "feature", "day" },
                unique: true);
        }
    }
}
