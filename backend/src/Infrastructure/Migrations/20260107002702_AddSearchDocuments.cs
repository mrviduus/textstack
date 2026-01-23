using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <summary>
    /// Creates the search_documents table for PostgreSQL full-text search.
    /// This table is used by TextStack.Search library (Dapper-based, not EF).
    /// </summary>
    public partial class AddSearchDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
                CREATE TABLE IF NOT EXISTS search_documents (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    language TEXT NOT NULL,
                    site_id UUID NOT NULL,
                    search_vector TSVECTOR NOT NULL,
                    metadata JSONB DEFAULT '{}',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_search_documents_search_vector ON search_documents USING GIN(search_vector);
                CREATE INDEX IF NOT EXISTS idx_search_documents_site_id ON search_documents(site_id);
                CREATE INDEX IF NOT EXISTS idx_search_documents_language ON search_documents(language);
            ");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
                DROP INDEX IF EXISTS idx_search_documents_language;
                DROP INDEX IF EXISTS idx_search_documents_site_id;
                DROP INDEX IF EXISTS idx_search_documents_search_vector;
                DROP TABLE IF EXISTS search_documents;
            ");
        }
    }
}
