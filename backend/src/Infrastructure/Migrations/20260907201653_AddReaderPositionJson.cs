using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddReaderPositionJson : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "progress_position_json",
                table: "user_books",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "position_json",
                table: "reading_progresses",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "progress_position_json",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "position_json",
                table: "reading_progresses");
        }
    }
}
