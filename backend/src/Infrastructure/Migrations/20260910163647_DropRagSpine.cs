using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Pgvector;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    /// <summary>
    /// Drops the retrieval spine: both chunk tables, the pgvector column on editions, and the seven
    /// RAG-state columns each on editions and user_books. IRREVERSIBLE — Down recreates the shapes,
    /// never the vectors.
    ///
    /// <para>Counted on production before writing this, 2026-09-09/10: <b>7 books of 1498 were ever
    /// indexed</b> (4 catalog editions of 1423, 3 uploads of 75), and <b>4 editions of 1423</b> carried
    /// a mean-pool embedding. The two features that read those vectors — the "Similar books" rail and
    /// semantic catalog search — were therefore already blank or FTS-only on more than 99% of the
    /// catalog. Keyword search is untouched: it runs on the Postgres FTS <c>search_vector</c>, not on
    /// this.</para>
    ///
    /// <para>Vision PDF transcription (<c>pdf.parse</c>) was <b>$4.14 of the project's $4.39 lifetime
    /// LLM spend — 94%</b>, and its only consumer was this chunking path. It bought the seven indexed
    /// books above. Reading PDFs never went through it: the reader renders the original document
    /// (ADR-012) and text extraction is deterministic, in TextStack.Extraction, covered in CI.</para>
    ///
    /// <para>The reasoning moves to the reader's own assistant over MCP, which reads chapters as plain
    /// text and needs no index at all. That is what makes this spine surplus rather than merely
    /// unused.</para>
    /// </summary>
    public partial class DropRagSpine : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "chapter_chunk");

            migrationBuilder.DropTable(
                name: "user_chapter_chunk");

            migrationBuilder.DropIndex(
                name: "ix_user_books_rag_indexing_started_at",
                table: "user_books");

            migrationBuilder.DropIndex(
                name: "ix_editions_embedding",
                table: "editions");

            migrationBuilder.DropIndex(
                name: "ix_editions_rag_indexing_started_at",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_chunk_count",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "rag_embedded_count",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "rag_error",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "rag_indexed_at",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "rag_indexing_started_at",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "rag_status",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "embedding",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_chunk_count",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_embedded_count",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_error",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_indexed_at",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_indexing_started_at",
                table: "editions");

            migrationBuilder.DropColumn(
                name: "rag_status",
                table: "editions");

            migrationBuilder.AlterDatabase()
                .OldAnnotation("Npgsql:PostgresExtension:vector", ",,");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:PostgresExtension:vector", ",,");

            migrationBuilder.AddColumn<int>(
                name: "rag_chunk_count",
                table: "user_books",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "rag_embedded_count",
                table: "user_books",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "rag_error",
                table: "user_books",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "rag_indexed_at",
                table: "user_books",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "rag_indexing_started_at",
                table: "user_books",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "rag_status",
                table: "user_books",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<Vector>(
                name: "embedding",
                table: "editions",
                type: "vector(1536)",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "rag_chunk_count",
                table: "editions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "rag_embedded_count",
                table: "editions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "rag_error",
                table: "editions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "rag_indexed_at",
                table: "editions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "rag_indexing_started_at",
                table: "editions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "rag_status",
                table: "editions",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "chapter_chunk",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    chapter_id = table.Column<Guid>(type: "uuid", nullable: false),
                    edition_id = table.Column<Guid>(type: "uuid", nullable: false),
                    chapter_ord = table.Column<int>(type: "integer", nullable: false),
                    char_end = table.Column<int>(type: "integer", nullable: false),
                    char_start = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    embedding = table.Column<Vector>(type: "vector(1536)", nullable: true),
                    is_summary = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    ord = table.Column<int>(type: "integer", nullable: false),
                    text = table.Column<string>(type: "text", nullable: false),
                    token_count = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_chapter_chunk", x => x.id);
                    table.ForeignKey(
                        name: "fk_chapter_chunk_chapters_chapter_id",
                        column: x => x.chapter_id,
                        principalTable: "chapters",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_chapter_chunk_editions_edition_id",
                        column: x => x.edition_id,
                        principalTable: "editions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_chapter_chunk",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_book_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_chapter_id = table.Column<Guid>(type: "uuid", nullable: true),
                    chapter_ord = table.Column<int>(type: "integer", nullable: false),
                    char_end = table.Column<int>(type: "integer", nullable: false),
                    char_start = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    embedding = table.Column<Vector>(type: "vector(1536)", nullable: true),
                    is_summary = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    ord = table.Column<int>(type: "integer", nullable: false),
                    section_path = table.Column<string>(type: "text", nullable: true),
                    source_page = table.Column<int>(type: "integer", nullable: true),
                    text = table.Column<string>(type: "text", nullable: false),
                    token_count = table.Column<int>(type: "integer", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_chapter_chunk", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_chapter_chunk_user_books_user_book_id",
                        column: x => x.user_book_id,
                        principalTable: "user_books",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_user_chapter_chunk_user_chapters_user_chapter_id",
                        column: x => x.user_chapter_id,
                        principalTable: "user_chapters",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "ix_user_books_rag_indexing_started_at",
                table: "user_books",
                column: "rag_indexing_started_at",
                filter: "rag_status = 1");

            migrationBuilder.CreateIndex(
                name: "ix_editions_embedding",
                table: "editions",
                column: "embedding")
                .Annotation("Npgsql:IndexMethod", "hnsw")
                .Annotation("Npgsql:IndexOperators", new[] { "vector_cosine_ops" });

            migrationBuilder.CreateIndex(
                name: "ix_editions_rag_indexing_started_at",
                table: "editions",
                column: "rag_indexing_started_at",
                filter: "rag_status = 1");

            migrationBuilder.CreateIndex(
                name: "ix_chapter_chunk_chapter_id",
                table: "chapter_chunk",
                column: "chapter_id");

            migrationBuilder.CreateIndex(
                name: "ix_chapter_chunk_edition_id_chapter_id_ord",
                table: "chapter_chunk",
                columns: new[] { "edition_id", "chapter_id", "ord" });

            migrationBuilder.CreateIndex(
                name: "ix_chapter_chunk_embedding",
                table: "chapter_chunk",
                column: "embedding")
                .Annotation("Npgsql:IndexMethod", "hnsw")
                .Annotation("Npgsql:IndexOperators", new[] { "vector_cosine_ops" });

            migrationBuilder.CreateIndex(
                name: "ix_chapter_chunk_summary",
                table: "chapter_chunk",
                columns: new[] { "edition_id", "chapter_ord" },
                filter: "is_summary");

            migrationBuilder.CreateIndex(
                name: "ix_user_chapter_chunk_embedding",
                table: "user_chapter_chunk",
                column: "embedding")
                .Annotation("Npgsql:IndexMethod", "hnsw")
                .Annotation("Npgsql:IndexOperators", new[] { "vector_cosine_ops" });

            migrationBuilder.CreateIndex(
                name: "ix_user_chapter_chunk_summary",
                table: "user_chapter_chunk",
                columns: new[] { "user_id", "user_book_id", "chapter_ord" },
                filter: "is_summary");

            migrationBuilder.CreateIndex(
                name: "ix_user_chapter_chunk_user_book_id_user_chapter_id_ord",
                table: "user_chapter_chunk",
                columns: new[] { "user_book_id", "user_chapter_id", "ord" });

            migrationBuilder.CreateIndex(
                name: "ix_user_chapter_chunk_user_chapter_id",
                table: "user_chapter_chunk",
                column: "user_chapter_id");

            migrationBuilder.CreateIndex(
                name: "ix_user_chapter_chunk_user_id_user_book_id",
                table: "user_chapter_chunk",
                columns: new[] { "user_id", "user_book_id" });
        }
    }
}
