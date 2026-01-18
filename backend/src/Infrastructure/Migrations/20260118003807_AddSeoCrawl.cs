using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSeoCrawl : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "seo_crawl_jobs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seed_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    host_allowlist_json = table.Column<string>(type: "jsonb", nullable: false),
                    max_pages = table.Column<int>(type: "integer", nullable: false),
                    max_depth = table.Column<int>(type: "integer", nullable: false),
                    concurrency = table.Column<int>(type: "integer", nullable: false),
                    crawl_delay_ms = table.Column<int>(type: "integer", nullable: false),
                    crawl_mode = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    user_agent = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    pages_crawled = table.Column<int>(type: "integer", nullable: false),
                    errors_count = table.Column<int>(type: "integer", nullable: false),
                    error = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_seo_crawl_jobs", x => x.id);
                    table.ForeignKey(
                        name: "fk_seo_crawl_jobs_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "seo_crawl_results",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    job_id = table.Column<Guid>(type: "uuid", nullable: false),
                    url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    normalized_url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    depth = table.Column<int>(type: "integer", nullable: false),
                    status_code = table.Column<int>(type: "integer", nullable: true),
                    content_type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    html_bytes = table.Column<int>(type: "integer", nullable: true),
                    title = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    meta_description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    h1 = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    canonical = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: true),
                    meta_robots = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    x_robots_tag = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    fetched_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    fetch_error = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_seo_crawl_results", x => x.id);
                    table.ForeignKey(
                        name: "fk_seo_crawl_results_seo_crawl_jobs_job_id",
                        column: x => x.job_id,
                        principalTable: "seo_crawl_jobs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_jobs_created_at",
                table: "seo_crawl_jobs",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_jobs_site_id",
                table: "seo_crawl_jobs",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_jobs_status",
                table: "seo_crawl_jobs",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_results_job_id",
                table: "seo_crawl_results",
                column: "job_id");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_results_job_id_normalized_url",
                table: "seo_crawl_results",
                columns: new[] { "job_id", "normalized_url" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_results_job_id_status_code",
                table: "seo_crawl_results",
                columns: new[] { "job_id", "status_code" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "seo_crawl_results");

            migrationBuilder.DropTable(
                name: "seo_crawl_jobs");
        }
    }
}
