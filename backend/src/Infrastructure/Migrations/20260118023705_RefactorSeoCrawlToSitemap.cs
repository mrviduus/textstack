using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RefactorSeoCrawlToSitemap : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_seo_crawl_results_job_id_normalized_url",
                table: "seo_crawl_results");

            migrationBuilder.DropColumn(
                name: "depth",
                table: "seo_crawl_results");

            migrationBuilder.DropColumn(
                name: "normalized_url",
                table: "seo_crawl_results");

            migrationBuilder.DropColumn(
                name: "crawl_mode",
                table: "seo_crawl_jobs");

            migrationBuilder.DropColumn(
                name: "host_allowlist_json",
                table: "seo_crawl_jobs");

            migrationBuilder.DropColumn(
                name: "seed_url",
                table: "seo_crawl_jobs");

            migrationBuilder.RenameColumn(
                name: "max_depth",
                table: "seo_crawl_jobs",
                newName: "total_urls");

            migrationBuilder.AddColumn<string>(
                name: "url_type",
                table: "seo_crawl_results",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_results_job_id_url",
                table: "seo_crawl_results",
                columns: new[] { "job_id", "url" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_seo_crawl_results_job_id_url",
                table: "seo_crawl_results");

            migrationBuilder.DropColumn(
                name: "url_type",
                table: "seo_crawl_results");

            migrationBuilder.RenameColumn(
                name: "total_urls",
                table: "seo_crawl_jobs",
                newName: "max_depth");

            migrationBuilder.AddColumn<int>(
                name: "depth",
                table: "seo_crawl_results",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "normalized_url",
                table: "seo_crawl_results",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "crawl_mode",
                table: "seo_crawl_jobs",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "host_allowlist_json",
                table: "seo_crawl_jobs",
                type: "jsonb",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "seed_url",
                table: "seo_crawl_jobs",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateIndex(
                name: "ix_seo_crawl_results_job_id_normalized_url",
                table: "seo_crawl_results",
                columns: new[] { "job_id", "normalized_url" },
                unique: true);
        }
    }
}
