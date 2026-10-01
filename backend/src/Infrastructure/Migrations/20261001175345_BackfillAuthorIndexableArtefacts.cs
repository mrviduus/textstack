using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <summary>
    /// The rest of the 2026-08-31 incident (docs/incidents/2026-08-31-authors-404-to-crawlers-only.md).
    /// `AddAuthorsGenresSeoFields` gave every existing author `indexable = false`; the August backfill
    /// flipped only those that already had a published book, leaving 102 artefact rows. Auto-publish
    /// has since published books by 14 of them, whose pages 404 to crawlers again. All 102 were
    /// created on or before 2026-03-16 and none of the values was chosen by anyone, so they all go
    /// true; from here on `false` only ever means an admin hid the author.
    /// </summary>
    public partial class BackfillAuthorIndexableArtefacts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                "UPDATE authors SET indexable = true WHERE NOT indexable AND created_at < '2026-03-17';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Not reversible: the false values were an accident, and restoring them would re-hide
            // authors that have published books. The pre-deploy backup holds the old values.
        }
    }
}
