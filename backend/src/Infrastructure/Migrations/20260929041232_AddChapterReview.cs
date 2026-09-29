using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddChapterReview : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "review_json",
                table: "book_insight",
                type: "jsonb",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "review_question",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    book_insight_id = table.Column<Guid>(type: "uuid", nullable: false),
                    block_index = table.Column<int>(type: "integer", nullable: false),
                    prompt = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    answer = table.Column<string>(type: "character varying(1500)", maxLength: 1500, nullable: false),
                    prompt_hash = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    stage = table.Column<int>(type: "integer", nullable: false),
                    interval_days = table.Column<double>(type: "double precision", nullable: false),
                    consecutive_correct = table.Column<int>(type: "integer", nullable: false),
                    next_review_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_reviewed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    total_reviews = table.Column<int>(type: "integer", nullable: false),
                    correct_reviews = table.Column<int>(type: "integer", nullable: false),
                    is_retired = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_review_question", x => x.id);
                    table.ForeignKey(
                        name: "fk_review_question_book_insight_book_insight_id",
                        column: x => x.book_insight_id,
                        principalTable: "book_insight",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_review_question_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_review_question_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_review_question_book_insight_id_prompt_hash",
                table: "review_question",
                columns: new[] { "book_insight_id", "prompt_hash" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_review_question_site_id",
                table: "review_question",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_review_question_user_id_is_retired_next_review_at",
                table: "review_question",
                columns: new[] { "user_id", "is_retired", "next_review_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "review_question");

            migrationBuilder.DropColumn(
                name: "review_json",
                table: "book_insight");
        }
    }
}
