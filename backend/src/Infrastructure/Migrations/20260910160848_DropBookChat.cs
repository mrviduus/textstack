using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    /// <summary>
    /// Drops the in-app book chat. IRREVERSIBLE: the Down migration recreates the tables empty,
    /// because the rows cannot be reconstructed.
    ///
    /// <para>What is lost, counted on production before writing this on 2026-09-09: 16 rows in
    /// book_conversation and 26 in conversation_message, across one human. book_conversation is
    /// upserted on read (GET /me/chat created a row), so 16 counted sheet-opens rather than
    /// conversations — the engagement number was smaller than it looked, not larger.</para>
    ///
    /// <para>The conversation moves to the reader's own assistant over MCP, where the model is better
    /// than anything we can afford to serve and the inference is paid for by their subscription.
    /// What comes home is the conclusion, in book_insight.</para>
    /// </summary>
    public partial class DropBookChat : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "conversation_message");

            migrationBuilder.DropTable(
                name: "book_conversation");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "book_conversation",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    edition_id = table.Column<Guid>(type: "uuid", nullable: true),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    spoiler_gate_enabled = table.Column<bool>(type: "boolean", nullable: false, defaultValue: true),
                    summarized_through_ord = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    summary = table.Column<string>(type: "text", nullable: true),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_book_conversation", x => x.id);
                    table.CheckConstraint("ck_book_conversation_target", "(edition_id IS NOT NULL AND user_book_id IS NULL) OR (edition_id IS NULL AND user_book_id IS NOT NULL)");
                    table.ForeignKey(
                        name: "fk_book_conversation_editions_edition_id",
                        column: x => x.edition_id,
                        principalTable: "editions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_conversation_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_conversation_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_book_conversation_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "conversation_message",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    conversation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    citations_json = table.Column<string>(type: "jsonb", nullable: true),
                    content = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ord = table.Column<int>(type: "integer", nullable: false),
                    role = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_conversation_message", x => x.id);
                    table.ForeignKey(
                        name: "fk_conversation_message_book_conversation_conversation_id",
                        column: x => x.conversation_id,
                        principalTable: "book_conversation",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_book_conversation_edition_id",
                table: "book_conversation",
                column: "edition_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_conversation_site_id",
                table: "book_conversation",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_conversation_user_book_id",
                table: "book_conversation",
                column: "user_book_id");

            migrationBuilder.CreateIndex(
                name: "ix_book_conversation_user_id_edition_id",
                table: "book_conversation",
                columns: new[] { "user_id", "edition_id" },
                unique: true,
                filter: "edition_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_book_conversation_user_id_user_book_id",
                table: "book_conversation",
                columns: new[] { "user_id", "user_book_id" },
                unique: true,
                filter: "user_book_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_conversation_message_conversation_id_ord",
                table: "conversation_message",
                columns: new[] { "conversation_id", "ord" },
                unique: true);
        }
    }
}
