using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddBookInsight : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "book_insight",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    edition_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: true),
                    chapter_slug = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    text = table.Column<string>(type: "text", nullable: false),
                    question = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    source = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false, defaultValue: "mcp"),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_book_insight", x => x.id);
                    table.CheckConstraint("ck_book_insight_target", "(edition_id IS NOT NULL AND user_book_id IS NULL) OR (edition_id IS NULL AND user_book_id IS NOT NULL)");
                    table.ForeignKey(
                        name: "fk_book_insight_editions_edition_id",
                        column: x => x.edition_id,
                        principalTable: "editions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_insight_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_insight_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_insight_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_book_insight_edition_id",
                table: "book_insight",
                column: "edition_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_insight_site_id",
                table: "book_insight",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_insight_user_book_id",
                table: "book_insight",
                column: "user_book_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_insight_user_id_edition_id_chapter_slug",
                table: "book_insight",
                columns: new[] { "user_id", "edition_id", "chapter_slug" },
                unique: true,
                filter: "edition_id IS NOT NULL")
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "ix_book_insight_user_id_user_book_id_chapter_slug",
                table: "book_insight",
                columns: new[] { "user_id", "user_book_id", "chapter_slug" },
                unique: true,
                filter: "user_book_id IS NOT NULL")
                .Annotation("Npgsql:NullsDistinct", false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "book_insight");
        }
    }
}
