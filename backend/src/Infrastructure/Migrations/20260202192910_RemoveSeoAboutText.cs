using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RemoveSeoAboutText : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "seo_about_text",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "seo_about_text",
                table: "authors");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "seo_about_text",
                table: "editions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "seo_about_text",
                table: "authors",
                type: "text",
                nullable: true);
        }
    }
}
