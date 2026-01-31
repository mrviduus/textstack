using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSeoContentBlocks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "seo_about_text",
                table: "editions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_faqs_json",
                table: "editions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_relevance_text",
                table: "editions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_themes_json",
                table: "editions",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "seo_about_text",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "seo_faqs_json",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "seo_relevance_text",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "seo_themes_json",
                table: "editions");
        }
    }
}
