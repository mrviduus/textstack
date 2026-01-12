using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddChapterPartFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "original_chapter_number",
                table: "chapters",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "part_number",
                table: "chapters",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "total_parts",
                table: "chapters",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "original_chapter_number",
                table: "chapters");

            migrationBuilder.DropColumn(
                name: "part_number",
                table: "chapters");

            migrationBuilder.DropColumn(
                name: "total_parts",
                table: "chapters");
        }
    }
}
