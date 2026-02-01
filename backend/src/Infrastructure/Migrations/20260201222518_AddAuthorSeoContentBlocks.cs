using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddAuthorSeoContentBlocks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "canonical_override",
                table: "authors",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_about_text",
                table: "authors",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_faqs_json",
                table: "authors",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_relevance_text",
                table: "authors",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_themes_json",
                table: "authors",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "canonical_override",
                table: "authors");

            migrationBuilder.DropColumn(
                name: "seo_about_text",
                table: "authors");

            migrationBuilder.DropColumn(
                name: "seo_faqs_json",
                table: "authors");

            migrationBuilder.DropColumn(
                name: "seo_relevance_text",
                table: "authors");

            migrationBuilder.DropColumn(
                name: "seo_themes_json",
                table: "authors");
        }
    }
}
