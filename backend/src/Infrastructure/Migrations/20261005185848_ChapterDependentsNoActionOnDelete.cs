using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ChapterDependentsNoActionOnDelete : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_bookmarks_chapters_chapter_id",
                table: "bookmarks");

            migrationBuilder.DropForeignKey(
                name: "fk_notes_chapters_chapter_id",
                table: "notes");

            migrationBuilder.DropForeignKey(
                name: "fk_reading_progresses_chapters_chapter_id",
                table: "reading_progresses");

            migrationBuilder.AddForeignKey(
                name: "fk_bookmarks_chapters_chapter_id",
                table: "bookmarks",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id");

            migrationBuilder.AddForeignKey(
                name: "fk_notes_chapters_chapter_id",
                table: "notes",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id");

            migrationBuilder.AddForeignKey(
                name: "fk_reading_progresses_chapters_chapter_id",
                table: "reading_progresses",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_bookmarks_chapters_chapter_id",
                table: "bookmarks");

            migrationBuilder.DropForeignKey(
                name: "fk_notes_chapters_chapter_id",
                table: "notes");

            migrationBuilder.DropForeignKey(
                name: "fk_reading_progresses_chapters_chapter_id",
                table: "reading_progresses");

            migrationBuilder.AddForeignKey(
                name: "fk_bookmarks_chapters_chapter_id",
                table: "bookmarks",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "fk_notes_chapters_chapter_id",
                table: "notes",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "fk_reading_progresses_chapters_chapter_id",
                table: "reading_progresses",
                column: "chapter_id",
                principalTable: "chapters",
                principalColumn: "id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
