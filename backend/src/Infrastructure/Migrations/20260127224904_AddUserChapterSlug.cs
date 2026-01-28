using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddUserChapterSlug : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "slug",
                table: "user_chapters",
                type: "character varying(255)",
                maxLength: 255,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_chapters_user_book_id_slug",
                table: "user_chapters",
                columns: new[] { "user_book_id", "slug" },
                unique: true);

            // Data migration: generate slugs for existing chapters
            migrationBuilder.Sql(@"
                UPDATE user_chapters
                SET slug = chapter_number::text || '-' ||
                    COALESCE(
                        NULLIF(
                            regexp_replace(
                                regexp_replace(lower(trim(title)), '[^a-z0-9]+', '-', 'g'),
                                '^-+|-+$', '', 'g'
                            ),
                            ''
                        ),
                        'section-' || chapter_number::text
                    )
                WHERE slug IS NULL;
            ");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_user_chapters_user_book_id_slug",
                table: "user_chapters");

            migrationBuilder.DropColumn(
                name: "slug",
                table: "user_chapters");
        }
    }
}
