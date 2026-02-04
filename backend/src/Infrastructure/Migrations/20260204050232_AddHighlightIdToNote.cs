using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddHighlightIdToNote : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "highlight_id",
                table: "notes",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_notes_highlight_id",
                table: "notes",
                column: "highlight_id",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "fk_notes_highlights_highlight_id",
                table: "notes",
                column: "highlight_id",
                principalTable: "highlights",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_notes_highlights_highlight_id",
                table: "notes");

            migrationBuilder.DropIndex(
                name: "ix_notes_highlight_id",
                table: "notes");

            migrationBuilder.DropColumn(
                name: "highlight_id",
                table: "notes");
        }
    }
}
