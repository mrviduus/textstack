using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddReadingTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "reading_goals",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    goal_type = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    target_value = table.Column<int>(type: "integer", nullable: false),
                    year = table.Column<int>(type: "integer", nullable: false),
                    is_active = table.Column<bool>(type: "boolean", nullable: false),
                    streak_min_minutes = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_reading_goals", x => x.id);
                    table.ForeignKey(
                        name: "fk_reading_goals_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_reading_goals_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "reading_sessions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    edition_id = table.Column<Guid>(type: "uuid", nullable: true),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: true),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ended_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    duration_seconds = table.Column<int>(type: "integer", nullable: false),
                    words_read = table.Column<int>(type: "integer", nullable: false),
                    start_percent = table.Column<double>(type: "double precision", nullable: false),
                    end_percent = table.Column<double>(type: "double precision", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_reading_sessions", x => x.id);
                    table.ForeignKey(
                        name: "fk_reading_sessions_editions_edition_id",
                        column: x => x.edition_id,
                        principalTable: "editions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_reading_sessions_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_reading_sessions_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_reading_sessions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_achievements",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    site_id = table.Column<Guid>(type: "uuid", nullable: false),
                    achievement_code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    unlocked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_achievements", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_achievements_sites_site_id",
                        column: x => x.site_id,
                        principalTable: "sites",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_user_achievements_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_reading_goals_site_id",
                table: "reading_goals",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_reading_goals_user_id_site_id",
                table: "reading_goals",
                columns: new[] { "user_id", "site_id" });

            migrationBuilder.CreateIndex(
                name: "ix_reading_goals_user_id_site_id_goal_type",
                table: "reading_goals",
                columns: new[] { "user_id", "site_id", "goal_type" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_edition_id",
                table: "reading_sessions",
                column: "edition_id");

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_site_id",
                table: "reading_sessions",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_user_book_id",
                table: "reading_sessions",
                column: "user_book_id");

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_user_id_edition_id_started_at",
                table: "reading_sessions",
                columns: new[] { "user_id", "edition_id", "started_at" },
                unique: true,
                filter: "edition_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_user_id_site_id",
                table: "reading_sessions",
                columns: new[] { "user_id", "site_id" });

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_user_id_started_at",
                table: "reading_sessions",
                columns: new[] { "user_id", "started_at" });

            migrationBuilder.CreateIndex(
                name: "ix_reading_sessions_user_id_user_book_id_started_at",
                table: "reading_sessions",
                columns: new[] { "user_id", "user_book_id", "started_at" },
                unique: true,
                filter: "user_book_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_user_achievements_site_id",
                table: "user_achievements",
                column: "site_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_achievements_user_id_site_id",
                table: "user_achievements",
                columns: new[] { "user_id", "site_id" });

            migrationBuilder.CreateIndex(
                name: "ix_user_achievements_user_id_site_id_achievement_code",
                table: "user_achievements",
                columns: new[] { "user_id", "site_id", "achievement_code" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "reading_goals");

            migrationBuilder.DropTable(
                name: "reading_sessions");

            migrationBuilder.DropTable(
                name: "user_achievements");
        }
    }
}
