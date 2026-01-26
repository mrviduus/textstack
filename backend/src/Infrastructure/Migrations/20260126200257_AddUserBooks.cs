using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddUserBooks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "storage_used_bytes",
                table: "users",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.CreateTable(
                name: "user_books",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    slug = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    language = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    description = table.Column<string>(type: "text", nullable: true),
                    cover_path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    toc_json = table.Column<string>(type: "jsonb", nullable: true),
                    status = table.Column<int>(type: "integer", nullable: false),
                    error_message = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_books", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_books_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_book_files",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: false),
                    original_file_name = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    storage_path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    format = table.Column<int>(type: "integer", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    file_size = table.Column<long>(type: "bigint", nullable: false),
                    uploaded_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_book_files", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_book_files_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_chapters",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: false),
                    chapter_number = table.Column<int>(type: "integer", nullable: false),
                    title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    html = table.Column<string>(type: "text", nullable: false),
                    plain_text = table.Column<string>(type: "text", nullable: false),
                    word_count = table.Column<int>(type: "integer", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_chapters", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_chapters_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_ingestion_jobs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_file_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    attempt_count = table.Column<int>(type: "integer", nullable: false),
                    error = table.Column<string>(type: "text", nullable: true),
                    source_format = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    units_count = table.Column<int>(type: "integer", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_ingestion_jobs", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_ingestion_jobs_user_book_files_user_book_file_id",
                        column: x => x.user_book_file_id,
                        principalTable: "user_book_files",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_user_ingestion_jobs_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_book_files_sha256",
                table: "user_book_files",
                column: "sha256");

            migrationBuilder.CreateIndex(
                name: "ix_user_book_files_user_book_id",
                table: "user_book_files",
                column: "user_book_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_books_status",
                table: "user_books",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_user_books_user_id",
                table: "user_books",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_books_user_id_slug",
                table: "user_books",
                columns: new[] { "user_id", "slug" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_chapters_user_book_id",
                table: "user_chapters",
                column: "user_book_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_chapters_user_book_id_chapter_number",
                table: "user_chapters",
                columns: new[] { "user_book_id", "chapter_number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_ingestion_jobs_created_at",
                table: "user_ingestion_jobs",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_user_ingestion_jobs_status",
                table: "user_ingestion_jobs",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_user_ingestion_jobs_user_book_file_id",
                table: "user_ingestion_jobs",
                column: "user_book_file_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_ingestion_jobs_user_book_id",
                table: "user_ingestion_jobs",
                column: "user_book_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "user_chapters");

            migrationBuilder.DropTable(
                name: "user_ingestion_jobs");

            migrationBuilder.DropTable(
                name: "user_book_files");

            migrationBuilder.DropTable(
                name: "user_books");

            migrationBuilder.DropColumn(
                name: "storage_used_bytes",
                table: "users");
        }
    }
}
