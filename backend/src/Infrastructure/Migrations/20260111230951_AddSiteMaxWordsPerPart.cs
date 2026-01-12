using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSiteMaxWordsPerPart : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "max_words_per_part",
                table: "sites",
                type: "integer",
                nullable: false,
                defaultValue: 2000);

            // Update existing rows to have the default value
            migrationBuilder.Sql("UPDATE sites SET max_words_per_part = 2000 WHERE max_words_per_part = 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "max_words_per_part",
                table: "sites");
        }
    }
}
