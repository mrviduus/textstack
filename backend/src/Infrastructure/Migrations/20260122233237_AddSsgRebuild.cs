using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSsgRebuild : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ssg_rebuild_jobs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    mode = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    concurrency = table.Column<int>(type: "integer", nullable: false),
                    timeout_ms = table.Column<int>(type: "integer", nullable: false),
                    book_slugs_json = table.Column<string>(type: "jsonb", nullable: true),
                    author_slugs_json = table.Column<string>(type: "jsonb", nullable: true),
                    genre_slugs_json = table.Column<string>(type: "jsonb", nullable: true),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    total_routes = table.Column<int>(type: "integer", nullable: false),
                    rendered_count = table.Column<int>(type: "integer", nullable: false),
                    failed_count = table.Column<int>(type: "integer", nullable: false),
                    error = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ssg_rebuild_jobs", x => x.id);
                    table.ForeignKey(
                        name: "fk_ssg_rebuild_jobs_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ssg_rebuild_results",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    route = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    route_type = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    success = table.Column<bool>(type: "boolean", nullable: false),
                    render_time_ms = table.Column<int>(type: "integer", nullable: true),
                    error = table.Column<string>(type: "text", nullable: true),
                    rendered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_ssg_rebuild_results", x => x.id);
                    table.ForeignKey(
                        name: "fk_ssg_rebuild_results_ssg_rebuild_jobs_job_id",
                        column: x => x.job_id,
                        principalTable: "ssg_rebuild_jobs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_ssg_rebuild_jobs_created_at",
                table: "ssg_rebuild_jobs",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_ssg_rebuild_jobs_site_id",
                table: "ssg_rebuild_jobs",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_ssg_rebuild_jobs_status",
                table: "ssg_rebuild_jobs",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_ssg_rebuild_results_job_id",
                table: "ssg_rebuild_results",
                column: "job_id");

            migrationBuilder.CreateIndex(
                name: "ix_ssg_rebuild_results_job_id_route",
                table: "ssg_rebuild_results",
                columns: new[] { "job_id", "route" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ssg_rebuild_results");

            migrationBuilder.DropTable(
                name: "ssg_rebuild_jobs");
        }
    }
}
