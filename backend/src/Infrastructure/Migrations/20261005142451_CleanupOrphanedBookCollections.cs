using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <summary>
    /// One-off: delete collection rows whose book the collection's owner no longer has — an upload
    /// that was deleted, or a catalog edition removed from the library. Those paths now remove the
    /// rows themselves; this clears what they left before. Data only, no schema change.
    /// </summary>
    public partial class CleanupOrphanedBookCollections : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DELETE FROM book_collections bc
                USING collections c
                WHERE c.id = bc.collection_id
                  AND (
                    (bc.book_type = 'userbook' AND NOT EXISTS (
                        SELECT 1 FROM user_books ub WHERE ub.id = bc.book_id AND ub.user_id = c.user_id))
                    OR
                    (bc.book_type = 'savedbook' AND NOT EXISTS (
                        SELECT 1 FROM user_libraries ul WHERE ul.edition_id = bc.book_id AND ul.user_id = c.user_id))
                  );
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Deleted orphans are not restorable and nothing reads them.
        }
    }
}
